/**
 * A sold subscription keeps the terms it was bought on. Rows sold before the
 * purchase-time freeze read the plan, so a plan edit stamps them first.
 */
import type { PrismaLike, Tx } from "@/lib/prisma";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/payments/checkout/handlers/subscription";

/**
 * Stamps the plan's current cadence, length and entitlement onto every sold
 * row that still reads them from the plan. Runs in the plan edit's tx, before
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
    },
  });
  if (!plan) return;
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
