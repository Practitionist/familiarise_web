import prisma from "@/lib/prisma";

/** #1834 — the settle sweep's key for a paid seat still HELD at settle time. */
export const HELD_PAID_SEAT_PREFIX = "held-paid-seat:";

/** The ₹0 row restoreClassSeatCredits writes for an ops credit return. */
const isOpsCreditReturn = (metadata: unknown) =>
  (metadata as { source?: unknown } | null)?.source === "free-credit-partial";

/**
 * #1771 K-5 — a seat leaves the needs-human queue only when the escalation was
 * answered: an ops credit return after its event, or no credit still consumed.
 * Any other refund on the payment leaves it queued (PR #1824 review).
 */
export async function dropSettled<
  T extends { createdAt: Date; paymentId: string | null },
>(items: T[]): Promise<T[]> {
  const ids = [
    ...new Set(items.flatMap((i) => (i.paymentId ? [i.paymentId] : []))),
  ];
  if (ids.length === 0) return items;
  const [returns, usages] = await Promise.all([
    prisma.refund.findMany({
      where: { paymentId: { in: ids }, status: "SUCCEEDED" },
      select: { paymentId: true, createdAt: true, metadata: true },
    }),
    prisma.referralCreditUsage.findMany({
      where: { paymentId: { in: ids } },
      select: { paymentId: true, amount: true },
    }),
  ]);
  const stillUsed = new Map<string, number>();
  for (const u of usages) {
    stillUsed.set(
      u.paymentId,
      (stillUsed.get(u.paymentId) ?? 0) + Number(u.amount),
    );
  }
  return items.filter((item) => {
    if (!item.paymentId) return true;
    const returnedSince = returns.some(
      (r) =>
        r.paymentId === item.paymentId &&
        r.createdAt > item.createdAt &&
        isOpsCreditReturn(r.metadata),
    );
    return !returnedSince && (stillUsed.get(item.paymentId) ?? 0) > 0;
  });
}

/**
 * #1834 — a held paid seat leaves the queue once ops has moved money on its
 * payment after the escalation: any refund raised since, pending or done.
 */
export async function dropAnsweredHeldSeats<
  T extends { createdAt: Date; paymentId: string | null },
>(items: T[]): Promise<T[]> {
  const ids = [
    ...new Set(items.flatMap((i) => (i.paymentId ? [i.paymentId] : []))),
  ];
  if (ids.length === 0) return items;
  const refunds = await prisma.refund.findMany({
    where: { paymentId: { in: ids }, status: { in: ["PENDING", "SUCCEEDED"] } },
    select: { paymentId: true, createdAt: true },
  });
  return items.filter(
    (item) =>
      !item.paymentId ||
      !refunds.some(
        (r) => r.paymentId === item.paymentId && r.createdAt > item.createdAt,
      ),
  );
}
