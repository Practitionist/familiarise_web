import { EarningsHoldReason } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";
import { SUPPORT_REFUND_SEND_GRACE_MS } from "@/lib/support/money-policy";
import {
  handTopUpCopy,
  MAX_REFUND_OWED_ATTEMPTS,
  OWED_ALREADY_HELD_PREFIX,
} from "@/lib/payments/operations/refund-owed";
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

/** What a door that lost the owed-marker stamp recorded: the top-up it could not add. */
const owedHeldContextSchema = z.object({
  paymentId: z.string(),
  heldKey: z.string(),
  owedPaise: z.number().positive(),
});

/** The part of a hand refund that settled an owed marker first (`settleOwedByHand`). */
const settledOwedMetaSchema = z.object({
  settledOwed: z.object({ key: z.string(), settledPaise: z.number() }),
});

/** What a refund paid toward top-ups: none of a holding refund, and none of a hand refund's share that settled one. */
function topUpPaidBy(
  refund: {
    dedupeKey: string | null;
    amountPaise: number | bigint;
    metadata: unknown;
  },
  heldKeys: ReadonlySet<string>,
): number {
  if (refund.dedupeKey && heldKeys.has(refund.dedupeKey)) return 0;
  const meta = settledOwedMetaSchema.safeParse(refund.metadata);
  const settledHeld =
    meta.success && heldKeys.has(meta.data.settledOwed.key)
      ? meta.data.settledOwed.settledPaise
      : 0;
  return Math.max(0, Number(refund.amountPaise) - settledHeld);
}

type OpenTopUp = {
  createdAt: Date;
  paymentId: string;
  heldKey: string;
  owedPaise: number;
};

/**
 * What each top-up still owes after the refunds that landed on its payment
 * since it was recorded, paid to the payment's oldest open top-up first (two
 * losing doors on one payment each close on their own share).
 */
function stillOwedFifo(
  topUps: ReadonlyMap<string, OpenTopUp>,
  refunds: readonly {
    paymentId: string;
    createdAt: Date;
    dedupeKey: string | null;
    amountPaise: number | bigint;
    metadata: unknown;
  }[],
): Map<string, number> {
  const oldestFirst = [...topUps.entries()].sort(
    ([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const still = new Map(oldestFirst.map(([ref, t]) => [ref, t.owedPaise]));
  const heldKeys = new Set(oldestFirst.map(([, t]) => t.heldKey));
  const byTime = [...refunds].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const refund of byTime) {
    let left = topUpPaidBy(refund, heldKeys);
    for (const [ref, t] of oldestFirst) {
      if (left <= 0) break;
      if (t.paymentId !== refund.paymentId || refund.createdAt <= t.createdAt)
        continue;
      const pays = Math.min(left, still.get(ref) ?? 0);
      still.set(ref, (still.get(ref) ?? 0) - pays);
      left -= pays;
    }
  }
  return still;
}

/** Held top-ups older than this leave the list unless their hold is still active; the runbook's triage query finds the rest. */
export const OWED_HELD_WINDOW_DAYS = 180;
const OWED_HELD_READ_LIMIT = 500;

/**
 * Doors whose refund another door's owed refund already held (first writer
 * wins). Open while money is still owed: refunds landed on the payment since
 * the event (oldest top-up first; never a holding refund, nor a hand refund's
 * share that settled one) cover less than the top-up, and the payment still has
 * a refundable balance. Any later refund on the payment counts, whatever its
 * reason. Once paid, the row asks for the door's OPERATOR hold to be released.
 */
export async function readOwedAlreadyHeld(
  now = new Date(),
  limit = OWED_HELD_READ_LIMIT,
) {
  // Oldest first inside the window, so an open row is never crowded out silently.
  const where = {
    category: "PAYMENT",
    createdAt: {
      gte: new Date(now.getTime() - OWED_HELD_WINDOW_DAYS * 86_400_000),
    },
    correlationId: { startsWith: OWED_ALREADY_HELD_PREFIX },
  };
  const recent = await prisma.systemEvent.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: limit,
    select: EVENT_SELECT,
  });
  const total =
    recent.length < limit
      ? recent.length
      : await prisma.systemEvent.count({ where });
  // A top-up whose hold is still active stays listed however old.
  const holdRefs = await prisma.earningsHold.findMany({
    where: {
      reason: EarningsHoldReason.OPERATOR,
      releasedAt: null,
      sourceRef: { startsWith: OWED_ALREADY_HELD_PREFIX },
    },
    distinct: ["sourceRef"],
    select: { sourceRef: true },
  });
  const heldEvents =
    holdRefs.length === 0
      ? []
      : await prisma.systemEvent.findMany({
          where: { correlationId: { in: holdRefs.map((h) => h.sourceRef) } },
          orderBy: { createdAt: "asc" },
          select: EVENT_SELECT,
        });
  const events = [...heldEvents, ...recent].sort(
    (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
  );
  const first = new Map<
    string,
    { e: EventRow; paymentId: string; heldKey: string; owedPaise: number }
  >();
  for (const e of events) {
    const ctx = owedHeldContextSchema.safeParse(e.context);
    if (!e.correlationId || !ctx.success || first.has(e.correlationId))
      continue;
    first.set(e.correlationId, { e, ...ctx.data });
  }
  const more =
    total > recent.length
      ? [
          {
            id: "owed-held:more",
            message: `${total - recent.length} more held top-up events are not listed yet (oldest first). Settle the rows above, then reload.`,
            createdAt: now,
            paymentId: null,
            occurrenceId: null,
            unitPaise: null,
            amountPaise: null,
            kind: "owed-already-held" as const,
            caseId: null,
            creditPlan: false,
          },
        ]
      : [];
  if (first.size === 0) return more;
  const paymentIds = [...new Set([...first.values()].map((r) => r.paymentId))];
  const payments = await prisma.payment.findMany({
    where: { id: { in: paymentIds } },
    select: {
      id: true,
      amount: true,
      refundOwedKey: true,
      refundOwedPaise: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const byPayment = new Map(payments.map((p) => [p.id, p]));
  const refunds = await prisma.refund.findMany({
    where: {
      paymentId: { in: paymentIds },
      status: { in: ["SUCCEEDED", "PENDING"] },
    },
    select: {
      paymentId: true,
      dedupeKey: true,
      createdAt: true,
      amountPaise: true,
      metadata: true,
    },
  });
  const activeHolds = await prisma.earningsHold.findMany({
    where: {
      reason: EarningsHoldReason.OPERATOR,
      sourceRef: { in: [...first.keys()] },
      releasedAt: null,
    },
    select: { sourceRef: true },
  });
  const held = new Set(activeHolds.map((h) => h.sourceRef));
  const still = stillOwedFifo(
    new Map(
      [...first.entries()].map(([ref, row]) => [
        ref,
        { ...row, createdAt: row.e.createdAt },
      ]),
    ),
    refunds,
  );
  const rows = [...first.entries()].flatMap(([ref, row]) => {
    const payment = byPayment.get(row.paymentId);
    const owed = Math.min(
      still.get(ref) ?? 0,
      payment ? refundableBalancePaise(Number(payment.amount), payment) : 0,
    );
    const holding = held.has(ref);
    if (owed <= 0 && !holding) return [];
    // A hand refund settles the still-stamped older refund first, so the door preset covers both.
    const older =
      payment?.refundOwedKey === row.heldKey && payment.refundOwedPaise !== null
        ? Number(payment.refundOwedPaise)
        : 0;
    const head = `Payment ${row.paymentId} (${row.heldKey}):`;
    return [
      {
        id: `owed-held:${ref}`,
        message:
          owed <= 0
            ? `${head} the top-up is settled; release the hold on its earnings from the Earnings tab.`
            : older > 0
              ? `${head} ${handTopUpCopy(owed, holding)} The older refund of ₹${(older / 100).toFixed(2)} is still owed and a hand refund settles it first, so refund ₹${((owed + older) / 100).toFixed(2)} in total.`
              : `${head} ${handTopUpCopy(owed, holding)}`,
        createdAt: row.e.createdAt,
        paymentId: row.paymentId,
        occurrenceId: null,
        unitPaise: null,
        /** The Issue-refund preset: the top-up, plus an older refund a hand refund settles first; null once only the hold release is left. */
        amountPaise: owed > 0 ? owed + older : null,
        kind: "owed-already-held" as const,
        caseId: null,
        creditPlan: false,
      },
    ];
  });
  return [...rows, ...more];
}

/**
 * #1771 K-5 — credit seats the automatic paths could not settle, plus (#1834)
 * paid seats still HELD at settle, plus approved support remedies with no live
 * refund, plus refunds another door's owed refund held. The Refunds tab lists these; #1527 — the Refunds nav badge counts the
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
  const owedHeld = await readOwedAlreadyHeld();
  const unsent = await readUnsentSupportRefunds();
  const items = [...credit, ...held, ...stuck, ...owedHeld, ...unsent].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return items;
}
