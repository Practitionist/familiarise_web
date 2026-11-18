// Creates the subscription with its first-cycle window and frozen
// entitlement, plus the placeholder wrapper the payment hangs on.

import { recordParticipants } from "@/lib/booking/participants";
import {
  appendCreationHistory,
  LIVE_SUBSCRIPTION_STATUSES,
} from "@/lib/booking/transitions";
import { convertCompletedTrial } from "@/lib/trials/conversion";
import { assertExpertTakesDirectCheckout } from "@/lib/booking/booking-rule-error";
import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import {
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { AppointmentsType, Prisma, AppointmentStatus } from "@prisma/client";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import type { SubscriptionCheckoutResult } from "@/lib/payments/checkout/schema";
import {
  assertSubscriptionDemandRoom,
  resolveSubscriptionPurchase,
} from "@/lib/payments/checkout/subscription-demand";

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
  const purchase = await resolveSubscriptionPurchase(
    tx,
    data,
    consulteeProfileId,
    precomputedSchedulingPeriod,
  );
  // A switch flipped while the order was minted refuses here; the abort tombstones that order.
  assertExpertTakesDirectCheckout(
    "SUBSCRIPTION",
    purchase.plan.consultantProfile,
  );
  const {
    plan,
    priorSubscription,
    schedulingTimezone,
    startDate,
    endDate,
    terms,
  } = purchase;
  const isSchedulingPeriodRequest = Boolean(
    data.schedulingPeriodStartsAt || data.renewsSubscriptionId,
  );

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
        `You already have this plan with ${sessionsLeft} session${sessionsLeft === 1 ? "" : "s"} left to schedule. Your expert schedules them, and you can buy it again once they are all scheduled.`,
      ),
      { httpStatus: 409, code: "SUBSCRIPTION_ALREADY_ACTIVE" },
    );
  }

  // Authoritative: orchestrate pre-checks before the gateway mint, and this
  // re-check under the same lock sees any sale committed since.
  await assertSubscriptionDemandRoom(tx, purchase, consulteeProfileId);

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
