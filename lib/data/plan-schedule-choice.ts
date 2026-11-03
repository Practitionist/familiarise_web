import prisma from "@/lib/prisma";
import {
  PLAN_CHOICES,
  lastChoiceWasAuto,
} from "@/lib/booking/allocation/schedule-choice";

/**
 * The plans whose newest plan-level scheduling choice (the allocation history
 * `reason`) was Auto. A week placed with the one-tap Auto, the sweep or a
 * reschedule is not a plan-level choice and never counts.
 */
export async function plansScheduledOnAuto(
  subscriptionIds: string[],
): Promise<Set<string>> {
  if (subscriptionIds.length === 0) return new Set();
  const rows = await prisma.bookingStatusHistory.findMany({
    where: {
      entity: "SUBSCRIPTION",
      entityId: { in: subscriptionIds },
      reason: { in: [...PLAN_CHOICES] },
    },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, reason: true },
  });
  const byPlan = new Map<string, (string | null)[]>();
  for (const row of rows) {
    byPlan.set(row.entityId, [...(byPlan.get(row.entityId) ?? []), row.reason]);
  }
  return new Set(
    [...byPlan]
      .filter(([, reasons]) => lastChoiceWasAuto(reasons))
      .map(([id]) => id),
  );
}
