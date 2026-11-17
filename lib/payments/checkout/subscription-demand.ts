// A subscription purchase's resolved terms and the two demand bounds on it,
// shared by the pre-mint check and the authoritative check in the commit.

import type { Tx } from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { NOT_PLACEABLE_MESSAGE } from "@/schemas/plan-feasibility";
import {
  firstCycleWindow,
  purchaseTermsOf,
  subscriptionPlanEnd,
} from "@/lib/booking/entitlement";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  assessExpertFeasibility,
  firstWeekPlaceable,
} from "@/lib/booking/feasibility";
import { leadMsFor } from "@/lib/booking/lead-time";
import { assertPlanClientRoom } from "@/lib/booking/plan-demand";
import { MAX_SUBSCRIPTION_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";
import {
  resolvePlanStart,
  resolvePriorSubscriptionForRenewal,
} from "@/lib/payments/checkout/renewal";

export type SubscriptionPurchase = Awaited<
  ReturnType<typeof resolveSubscriptionPurchase>
>;

/** The plan, the renewal source, the first-cycle window and the terms a purchase freezes. */
export async function resolveSubscriptionPurchase(
  db: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  precomputedSchedulingPeriod?: { startsAt: Date; endsAt: Date } | null,
) {
  const plan = await db.subscriptionPlan.findUnique({
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

  const priorSubscription = await resolvePriorSubscriptionForRenewal(
    db,
    data.renewsSubscriptionId,
    consulteeProfileId,
    plan.id,
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
  return {
    plan,
    priorSubscription,
    schedulingTimezone,
    startDate,
    endDate,
    terms,
  };
}

/**
 * Refuses a purchase the expert cannot take: a new client past their limit
 * (409 `PLAN_CLIENTS_FULL`), or a first week that their hours, less other sold
 * plans' unplaced sessions, cannot hold at all (409 `NOT_PLACEABLE`). Callers
 * hold the expert's request-cap key, so concurrent buyers serialise.
 */
export async function assertSubscriptionDemandRoom(
  db: Tx,
  purchase: SubscriptionPurchase,
  consulteeProfileId: string,
): Promise<void> {
  const { plan, priorSubscription, terms } = purchase;
  await assertPlanClientRoom(db, {
    consultantProfileId: plan.consultantProfileId,
    consulteeProfileId,
  });

  // A thin first week still sells: the buyer was shown the room-for-N notice.
  const firstWeek = await assessExpertFeasibility(db, {
    consultantProfileId: plan.consultantProfileId,
    zone: purchase.schedulingTimezone,
    sessionMinutes: terms.sessionMinutes,
    sessionsPerWeek: terms.sessionsPerWeek,
    perDayCap: MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
    notBeforeMs: Math.max(
      purchase.startDate.getTime(),
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
      new Error(NOT_PLACEABLE_MESSAGE),
      { httpStatus: 409, code: "NOT_PLACEABLE", reasons: firstWeek.reasons },
    );
  }
}
