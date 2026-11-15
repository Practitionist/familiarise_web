/**
 * A sold subscription keeps its terms, a 1:1 request or trial its agreed price.
 * Rows from before the freeze read the plan, so a plan edit stamps them first.
 */
import type { PrismaLike, Tx } from "@/lib/prisma";
import { planEndOf, weeksPlanEndOf } from "@/lib/booking/entitlement";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/booking/transitions";

/**
 * Stamps the plan's current cadence, length, entitlement and end onto every
 * sold row that still reads them from the plan. Runs in the plan edit's tx, before
 * the plan row changes; the null predicates make a concurrent edit a no-op.
 */
export async function freezeSoldTerms(
  tx: Pick<Tx, "subscription" | "subscriptionPlan">,
  subscriptionPlanId: string,
): Promise<void> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: subscriptionPlanId },
    select: {
      sessionsPerWeek: true,
      sessionDurationInHours: true,
      totalSessions: true,
      durationInMonths: true,
      durationInWeeks: true,
    },
  });
  if (!plan) return;
  // A row with no stored end derives it from the plan's length; fix it from
  // the length it was sold at before the edit can move it.
  const unended = await tx.subscription.findMany({
    where: { subscriptionPlanId, planEndsAt: null },
    select: {
      id: true,
      schedulingPeriodStartsAt: true,
      schedulingTimezone: true,
    },
  });
  // Each row's end depends on its own start and zone, so each is its own CAS
  // write; an interactive transaction runs them one at a time on one connection.
  for (const row of unended) {
    await tx.subscription.updateMany({
      where: { id: row.id, planEndsAt: null },
      data: {
        planEndsAt:
          plan.durationInWeeks !== null
            ? weeksPlanEndOf(
                row.schedulingPeriodStartsAt,
                plan.durationInWeeks,
                row.schedulingTimezone,
              )
            : planEndOf(
                row.schedulingPeriodStartsAt,
                plan.durationInMonths,
                row.schedulingTimezone,
              ),
      },
    });
  }
  await tx.subscription.updateMany({
    where: { subscriptionPlanId, sessionsPerWeek: null },
    data: { sessionsPerWeek: plan.sessionsPerWeek },
  });
  await tx.subscription.updateMany({
    where: { subscriptionPlanId, sessionMinutes: null },
    data: { sessionMinutes: Math.round(plan.sessionDurationInHours * 60) },
  });
  await tx.subscription.updateMany({
    where: { subscriptionPlanId, sessionsTotal: null },
    data: { sessionsTotal: plan.totalSessions },
  });
}

/**
 * Stamps the consultation plan's current price onto every request that still
 * reads it from the plan; same tx and ordering as freezeSoldTerms.
 */
export async function freezeConsultationPrice(
  tx: Pick<Tx, "consultation" | "consultationPlan">,
  consultationPlanId: string,
): Promise<void> {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: consultationPlanId },
    select: { price: true },
  });
  if (!plan) return;
  await tx.consultation.updateMany({
    where: { consultationPlanId, agreedPricePaise: null },
    data: { agreedPricePaise: plan.price },
  });
}

/**
 * Stamps the plan's current trial price onto every trial that still reads it
 * from the plan; same tx and ordering as freezeSoldTerms.
 */
export async function freezeTrialPrice(
  tx: Pick<Tx, "trial" | "subscriptionPlan">,
  subscriptionPlanId: string,
): Promise<void> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: subscriptionPlanId },
    select: { trialPriceInPaise: true },
  });
  if (!plan) return;
  await tx.trial.updateMany({
    where: { subscriptionPlanId, agreedPricePaise: null },
    data: { agreedPricePaise: plan.trialPriceInPaise },
  });
}

/** The price a 1:1 request runs on, in paise: agreed at request, else the plan's. */
export function agreedConsultationPricePaise(consultation: {
  agreedPricePaise: number | null;
  consultationPlan: { price: number };
}): number {
  return consultation.agreedPricePaise ?? consultation.consultationPlan.price;
}

/** The price a trial runs on, in paise: agreed at request, else the plan's. */
export function agreedTrialPricePaise(trial: {
  agreedPricePaise: number | null;
  subscriptionPlan: { trialPriceInPaise: number };
}): number {
  return trial.agreedPricePaise ?? trial.subscriptionPlan.trialPriceInPaise;
}

/** Live buyers of a plan: the clients a plan edit leaves on their own terms. */
export function activeClientCount(
  db: PrismaLike,
  subscriptionPlanId: string,
): Promise<number> {
  return db.subscription.count({
    where: {
      subscriptionPlanId,
      deletedAt: null,
      status: { in: LIVE_SUBSCRIPTION_STATUSES },
    },
  });
}
