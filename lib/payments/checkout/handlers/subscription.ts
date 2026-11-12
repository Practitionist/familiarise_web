// Creates the subscription with its first-cycle window and frozen
// entitlement, plus the placeholder wrapper the payment hangs on.

import { recordParticipants } from "@/lib/booking/participants";
import {
  appendCreationHistory,
  LIVE_SUBSCRIPTION_STATUSES,
} from "@/lib/booking/transitions";
import { convertCompletedTrial } from "@/lib/trials/conversion";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import {
  firstCycleWindow,
  purchaseTermsOf,
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionPlanEnd,
} from "@/lib/booking/entitlement";
import { AppointmentsType, Prisma, AppointmentStatus } from "@prisma/client";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  assessExpertFeasibility,
  firstWeekPlaceable,
} from "@/lib/booking/feasibility";
import { leadMsFor } from "@/lib/booking/lead-time";
import { assertPlanClientRoom } from "@/lib/booking/plan-demand";
import { MAX_SUBSCRIPTION_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";
import type { SubscriptionCheckoutResult } from "@/lib/payments/checkout/schema";
import {
  resolvePlanStart,
  resolvePriorSubscriptionForRenewal,
} from "@/lib/payments/checkout/renewal";

export async function handleSubscriptionCheckout(
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
  /** Resolved org context — see handleConsultationCheckout for rationale. */
  organizationId: string | null,
  /** #1499 — see handleConsultationCheckout. */
  cancellationPolicyId: string,
  precomputedSchedulingPeriod?: { startsAt: Date; endsAt: Date } | null,
): Promise<SubscriptionCheckoutResult> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // #1743 — validate renewal source when renewsSubscriptionId is provided.
  const priorSubscription = await resolvePriorSubscriptionForRenewal(
    tx,
    data.renewsSubscriptionId,
    consulteeProfileId,
    plan.id,
  );

  const isSchedulingPeriodRequest = Boolean(
    data.schedulingPeriodStartsAt || data.renewsSubscriptionId,
  );
  // The persisted window is the first cycle; a client end is ignored. A
  // renewal starts no earlier than the prior plan's end, and the plan end is
  // fixed here once, from the start.
  const schedulingTimezone = resolveSchedulingTimezone(
    plan.consultantProfile?.user?.timezone,
  );
  const priorPlanEnd = priorSubscription
    ? subscriptionPlanEnd(priorSubscription)
    : null;
  const { start: startDate, end: endDate } =
    precomputedSchedulingPeriod &&
    (!priorPlanEnd || precomputedSchedulingPeriod.startsAt >= priorPlanEnd)
      ? {
          start: precomputedSchedulingPeriod.startsAt,
          end: precomputedSchedulingPeriod.endsAt,
        }
      : firstCycleWindow(
          plan,
          resolvePlanStart(
            data.schedulingPeriodStartsAt,
            priorPlanEnd,
            new Date(),
          ),
          schedulingTimezone,
        );
  // The plan's terms are frozen here once; plan edits apply to new buyers only.
  const terms = purchaseTermsOf(plan, startDate, schedulingTimezone);

  // #1766 — the double-buy guard follows the entitlement, not the window: a
  // live row with sessions left blocks; a spent one is a renewal-as-repurchase.
  // #1743 — exclude the priorSubscription being explicitly renewed.
  const liveRows = await tx.subscription.findMany({
    where: {
      subscriptionPlanId: plan.id,
      requestedById: consulteeProfileId,
      deletedAt: null,
      status: { in: LIVE_SUBSCRIPTION_STATUSES },
      ...(priorSubscription ? { id: { not: priorSubscription.id } } : {}),
    },
    select: {
      sessionsTotal: true,
      sessionsPerWeek: true,
      sessionsRefunded: true,
      schedulingPeriodStartsAt: true,
      schedulingTimezone: true,
      planEndsAt: true,
      subscriptionPlan: {
        select: {
          totalSessions: true,
          sessionsPerWeek: true,
          durationInMonths: true,
        },
      },
      appointment: {
        select: {
          occurrences: {
            select: {
              startsAt: true,
              endsAt: true,
              completionStatus: true,
              isTentative: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  const sessionsLeft = liveRows.reduce(
    (max, row) =>
      Math.max(
        max,
        subscriptionEntitlement({
          ...soldTermsOf(row),
          occurrences: row.appointment?.occurrences ?? [],
          schedulingPeriodStartsAt: row.schedulingPeriodStartsAt,
          schedulingTimezone: row.schedulingTimezone,
          planEndsAt: row.planEndsAt,
        }).remaining,
      ),
    0,
  );
  if (sessionsLeft > 0) {
    throw Object.assign(
      new Error(
        `You already have this plan with ${sessionsLeft} session${sessionsLeft === 1 ? "" : "s"} left — schedule those first.`,
      ),
      { httpStatus: 409, code: "SUBSCRIPTION_ALREADY_ACTIVE" },
    );
  }

  // Both read under the expert's request-cap key, so concurrent buyers serialise.
  await assertPlanClientRoom(tx, {
    consultantProfileId: plan.consultantProfileId,
    consulteeProfileId,
  });

  // A plan whose first week the expert's hours, less other sold plans'
  // unplaced sessions, can't hold at all is not sold; a thin one is, because
  // the buyer was shown the room-for-N notice.
  const firstWeek = await assessExpertFeasibility(tx, {
    consultantProfileId: plan.consultantProfileId,
    zone: schedulingTimezone,
    sessionMinutes: terms.sessionMinutes,
    sessionsPerWeek: terms.sessionsPerWeek,
    perDayCap: MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
    notBeforeMs: Math.max(
      startDate.getTime(),
      Date.now() + leadMsFor("allocate", { settled: true }),
    ),
    weeks: 1,
    countBookings: true,
    planDemand: {
      excludeSubscriptionIds: priorSubscription ? [priorSubscription.id] : [],
    },
  });
  if (firstWeekPlaceable(firstWeek) === 0) {
    throw Object.assign(
      new Error(
        "This expert has no free time in the first week of this plan right now. Pick a later start date, or ask them to open more hours.",
      ),
      { httpStatus: 409, code: "NOT_PLACEABLE", reasons: firstWeek.reasons },
    );
  }

  // Create subscription - consultant will allocate slots via Requests tab
  let subscription: Prisma.SubscriptionGetPayload<Record<string, never>>;
  try {
    subscription = await tx.subscription.create({
      data: {
        subscriptionPlanId: plan.id,
        status: AppointmentStatus.PENDING, // Always PENDING until consultant allocates slots
        requestedById: consulteeProfileId,
        requestNotes: data.notes,
        bookingSource: "DIRECT_CHECKOUT",
        schedulingPeriodStartsAt: startDate,
        schedulingPeriodEndsAt: endDate,
        // #1076 — caps bucket on the consultant's days, not the column default.
        schedulingTimezone,
        // #1766 — the entitlement, cadence and length are frozen at purchase.
        ...terms,
        ...(priorSubscription
          ? { renewedFromSubscriptionId: priorSubscription.id }
          : {}),
      },
    });
  } catch (createErr) {
    if (
      isUniqueViolationOn(createErr, "renewedFromSubscriptionId") ||
      isUniqueViolationOn(createErr, "renewsSubscriptionId")
    ) {
      throw Object.assign(
        new Error("This subscription has already been renewed."),
        { httpStatus: 409, code: "ALREADY_RENEWED" },
      );
    }
    throw createErr;
  }

  // A no-gateway checkout is paid now; a card checkout converts at capture.
  if (skipPayment) await convertCompletedTrial(tx, subscription.id);

  // FIX Issue #2: Create placeholder appointment for payment linkage
  // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
  // Makes this handler symmetrical with others - consultant allocates slots later
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      organizationId,
      // #1499 — the placeholder carries the money, so it must carry the terms too:
      // the sessions allocated later inherit this row's policy, and `cancellation-
      // scope` reads the terms off whichever row the Payment hangs on. The old Json
      // snapshot was never written here, which is why the fallback in that module
      // existed at all.
      cancellationPolicyId,
      // No slots created - consultant allocates later via Requests tab
    },
  });
  // #1319 A9 — the placeholder has no slots yet, but the buyer is a
  // participant of the engagement from the moment they hold it.
  const consulteeUser = await tx.consulteeProfile.findUnique({
    where: { id: consulteeProfileId },
    select: { userId: true },
  });
  if (consulteeUser) {
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId: consulteeUser.userId, role: "CONSULTEE" }],
      { organizationId, status: skipPayment ? "CONFIRMED" : "HELD" },
    );
  }
  // #1333 — see handleConsultationCheckout. Placed after the buyer lookup so
  // the opening row carries the same attribution the participant rows do.
  await appendCreationHistory(
    tx,
    "SUBSCRIPTION",
    subscription.id,
    AppointmentStatus.PENDING,
    {
      appointmentId: appointment.id,
      actorUserId: consulteeUser?.userId ?? null,
      organizationId,
    },
  );

  return {
    appointment,
    subscription,
    plan,
    amount: plan.price,
    isSchedulingPeriodRequest: !!isSchedulingPeriodRequest,
  };
}
