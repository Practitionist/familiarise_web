import prisma from "@/lib/prisma";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";
import { SUPPORT_REFUND_SEND_GRACE_MS } from "@/lib/support/money-policy";
import { MAX_REFUND_OWED_ATTEMPTS } from "@/lib/payments/operations/refund-owed";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { PARTIAL_CREDIT_CLOSED_PREFIX } from "@/lib/payments/operations/credit-plan-return";

/** #1834 — the settle sweep's key for a paid seat still HELD at settle time. */
export const HELD_PAID_SEAT_PREFIX = "held-paid-seat:";

/** The ₹0 row restoreSessionCredits writes for an ops credit return. */
const isOpsCreditReturn = (metadata: unknown) =>
  (metadata as { source?: unknown } | null)?.source === "free-credit-partial";

/**
 * #1771 K-5 — a seat leaves the needs-human queue only when the escalation was
 * answered: an ops credit return or an ops "no credit owed" after its event,
 * or no credit still consumed. Any other refund on the payment leaves it
 * queued (PR #1824 review).
 */
export async function dropSettled<
  T extends { createdAt: Date; paymentId: string | null },
>(items: T[]): Promise<T[]> {
  const ids = [
    ...new Set(items.flatMap((i) => (i.paymentId ? [i.paymentId] : []))),
  ];
  if (ids.length === 0) return items;
  const [returns, usages, closes] = await Promise.all([
    prisma.refund.findMany({
      where: { paymentId: { in: ids }, status: "SUCCEEDED" },
      select: { paymentId: true, createdAt: true, metadata: true },
    }),
    prisma.referralCreditUsage.findMany({
      where: { paymentId: { in: ids } },
      select: { paymentId: true, amount: true },
    }),
    prisma.systemEvent.findMany({
      where: {
        correlationId: {
          in: ids.map((id) => `${PARTIAL_CREDIT_CLOSED_PREFIX}${id}`),
        },
      },
      select: { correlationId: true, createdAt: true },
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
    const closedSince = closes.some(
      (c) =>
        c.correlationId ===
          `${PARTIAL_CREDIT_CLOSED_PREFIX}${item.paymentId}` &&
        c.createdAt > item.createdAt,
    );
    return (
      !returnedSince && !closedSince && (stillUsed.get(item.paymentId) ?? 0) > 0
    );
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

const LIVE_DISPUTE = {
  status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
} as const;

/**
 * Owed refunds no automatic path will settle, read from the payments that
 * hold them: a marker that spent its attempts, or one a live dispute holds,
 * whether a booking change hit it or only the plan-end pass is waiting on it.
 * Listed until the marker clears.
 */
export async function readStuckOwedRefunds() {
  const rows = await prisma.payment.findMany({
    where: {
      refundOwedKey: { not: null },
      deletedAt: null,
      OR: [
        { refundOwedAttempts: { gte: MAX_REFUND_OWED_ATTEMPTS } },
        { disputes: { some: LIVE_DISPUTE } },
      ],
    },
    orderBy: [{ refundOwedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdAt: true,
      refundOwedKey: true,
      refundOwedPaise: true,
      refundOwedAt: true,
      refundOwedAttempts: true,
      disputes: { where: LIVE_DISPUTE, select: { id: true }, take: 1 },
    },
  });
  return rows.map((row) => {
    const owed =
      row.refundOwedPaise === null
        ? "its full balance"
        : `₹${(Number(row.refundOwedPaise) / 100).toFixed(2)}`;
    const message = `${
      row.disputes.length > 0
        ? `Payment ${row.id} owes a refund of ${owed} (${row.refundOwedKey}) that a live dispute holds. Settle the dispute, then refund it by hand.`
        : `Payment ${row.id} owes a refund of ${owed} (${row.refundOwedKey}) that failed ${row.refundOwedAttempts} times. Refund it by hand.`
    } Its earnings stay held until this is settled.`;
    return {
      id: `stuck-owed:${row.id}`,
      message,
      createdAt: row.refundOwedAt ?? row.createdAt,
      paymentId: row.id,
      occurrenceId: null,
      unitPaise: null,
      kind: "stuck-owed-refund" as const,
      caseId: null,
      creditPlan: false,
    };
  });
}

type EventRow = {
  id: string;
  message: string;
  context: unknown;
  createdAt: Date;
  correlationId: string | null;
};

const EVENT_SELECT = {
  id: true,
  message: true,
  context: true,
  createdAt: true,
  correlationId: true,
} as const;

/** A subscription paid in referral credit whose undelivered share waits on ops. */
const PARTIAL_CREDIT_PREFIX = "partial-credit:";

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
    /** An ended credit plan: ops may also answer that no credit is owed. */
    creditPlan:
      kind === "credit" &&
      (e.correlationId?.startsWith(PARTIAL_CREDIT_PREFIX) ?? false),
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
  // A partial-credit row stays listed while its credit is still consumed,
  // however old: every row is read and settled ones dropped before any
  // ordering, so answered rows piling up never push an open one off the list.
  const creditEvents = await prisma.systemEvent.findMany({
    where: {
      OR: [
        { correlationId: { startsWith: PARTIAL_CREDIT_PREFIX } },
        {
          message: { contains: "CREDIT_SEAT_PARTIAL_RESTORE" },
          createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
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
  const stuck = await readStuckOwedRefunds();
  const unsent = await readUnsentSupportRefunds();
  const items = [...credit, ...held, ...stuck, ...unsent].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return items;
}
