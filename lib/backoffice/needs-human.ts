import prisma from "@/lib/prisma";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";
import { SUPPORT_REFUND_SEND_GRACE_MS } from "@/lib/support/money-policy";

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
 * #1834 — a held paid seat leaves the queue only when a refund keyed to its
 * own occurrence and payment (`occ:<occurrence>:pay:<payment>`) is pending or done.
 */
export async function dropAnsweredHeldSeats<
  T extends { paymentId: string | null; occurrenceId: string | null },
>(items: T[]): Promise<T[]> {
  const keyOf = (i: T) =>
    i.paymentId && i.occurrenceId
      ? occurrenceRefundKey(i.occurrenceId, i.paymentId)
      : null;
  const keys = items.flatMap((i) => keyOf(i) ?? []);
  if (keys.length === 0) return items;
  const answered = await prisma.refund.findMany({
    where: {
      dedupeKey: { in: keys },
      status: { in: ["PENDING", "SUCCEEDED"] },
    },
    select: { dedupeKey: true },
  });
  const done = new Set(answered.map((r) => r.dedupeKey));
  return items.filter((i) => {
    const key = keyOf(i);
    return !key || !done.has(key);
  });
}

type EventRow = {
  id: string;
  message: string;
  context: unknown;
  createdAt: Date;
};

const EVENT_SELECT = {
  id: true,
  message: true,
  context: true,
  createdAt: true,
} as const;

function contextString(ctx: unknown, key: string): string | null {
  const v = (ctx as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : null;
}

function toItem(e: EventRow, kind: "credit" | "held-paid-seat") {
  const unit = (e.context as { unitPaise?: unknown } | null)?.unitPaise;
  return {
    id: e.id,
    message: e.message,
    createdAt: e.createdAt,
    paymentId: contextString(e.context, "paymentId"),
    occurrenceId: contextString(e.context, "occurrenceId"),
    unitPaise: typeof unit === "number" ? unit : null,
    kind,
    caseId: null as string | null,
  };
}

/**
 * Support remedies approved without a live refund: the refund was refused,
 * failed at the gateway, or never ran. Each needs a retry or a void on its case.
 */
export async function readUnsentSupportRefunds(now = new Date()) {
  const rows = await prisma.supportFinancialRecommendation.findMany({
    where: {
      approved: true,
      decidedAt: {
        lte: new Date(now.getTime() - SUPPORT_REFUND_SEND_GRACE_MS),
      },
      OR: [
        { refundId: null },
        { refund: { status: { in: ["FAILED", "CANCELLED"] } } },
      ],
    },
    orderBy: { decidedAt: "desc" },
    take: 100,
    select: {
      id: true,
      caseId: true,
      paymentId: true,
      amountPaise: true,
      decidedAt: true,
      createdAt: true,
      refund: { select: { status: true } },
      supportCase: { select: { referenceNumber: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    message: `Support case ${row.supportCase.referenceNumber}: an approved refund of ₹${(Number(row.amountPaise) / 100).toFixed(2)} ${row.refund ? "failed" : "was never sent"}. Retry or void it on the case.`,
    createdAt: row.decidedAt ?? row.createdAt,
    paymentId: row.paymentId,
    occurrenceId: null,
    unitPaise: null,
    kind: "support-recommendation" as const,
    caseId: row.caseId,
  }));
}

/**
 * #1771 K-5 — credit seats the automatic paths could not settle, plus (#1834)
 * paid seats still HELD at settle, plus approved support remedies with no live
 * refund. The Refunds tab lists these; #1527 — the Refunds nav badge counts the
 * same list, so it is the one reader.
 */
export async function readRefundNeedsHuman() {
  // Sequential reads: one pooled connection (PG_POOL_MAX=1) serialises them anyway.
  const creditEvents = await prisma.systemEvent.findMany({
    where: {
      OR: [
        { correlationId: { startsWith: "partial-credit:" } },
        { message: { contains: "CREDIT_SEAT_PARTIAL_RESTORE" } },
      ],
      createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: EVENT_SELECT,
  });
  // #1834 — a held paid seat is a rare anomaly that stays listed until its own
  // refund lands, so this read has no age window and no shared cap.
  const heldEvents = await prisma.systemEvent.findMany({
    where: { correlationId: { startsWith: HELD_PAID_SEAT_PREFIX } },
    orderBy: { createdAt: "desc" },
    select: EVENT_SELECT,
  });
  const credit = await dropSettled(
    creditEvents.map((e) => toItem(e, "credit")),
  );
  const held = await dropAnsweredHeldSeats(
    heldEvents.map((e) => toItem(e, "held-paid-seat")),
  );
  const unsent = await readUnsentSupportRefunds();
  const items = [...credit, ...held, ...unsent].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return items;
}
