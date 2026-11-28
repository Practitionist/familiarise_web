import { EarningsHoldReason, type AppointmentStatus } from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { OWED_ALREADY_HELD_PREFIX } from "@/lib/payments/payouts/earnings-holds";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { occurrenceRefundKey } from "@/lib/booking/class-sessions";
import { SUPPORT_REFUND_SEND_GRACE_MS } from "@/lib/support/money-policy";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/booking/transitions";
import { subscriptionIsOver } from "@/lib/booking/entitlement";
import {
  handTopUpCopy,
  MAX_REFUND_OWED_ATTEMPTS,
} from "@/lib/payments/operations/refund-owed";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { PLAN_TITLE_SELECT, planTitle } from "@/lib/support/case-read";
import { formatCurrencyAmount } from "@/utils/formatting";
import { PARTIAL_CREDIT_CLOSED_PREFIX } from "@/lib/payments/operations/credit-plan-return";
import { INCIDENT_NO_SHOW_CLAIM_PREFIX } from "@/lib/booking/incident-keys";

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

/** Rupees with Indian digit grouping: ₹1,50,000.00. */
const inr = (paise: number) => formatCurrencyAmount(paise, "INR");

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
      user: { select: { name: true } },
      appointment: { select: PLAN_TITLE_SELECT },
    },
  });
  return rows.map((row) => {
    const owed =
      row.refundOwedPaise === null
        ? "the full balance"
        : inr(Number(row.refundOwedPaise));
    const who = row.user?.name ?? "A buyer";
    const booking = row.appointment ? planTitle(row.appointment) : "a booking";
    const message = `${
      row.disputes.length > 0
        ? `${who} is owed a refund of ${owed} on ${booking} that a live dispute holds. Settle the dispute, then refund it by hand.`
        : `${who} is owed a refund of ${owed} on ${booking} that failed ${row.refundOwedAttempts} times. Refund it by hand.`
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

function toItem(
  e: EventRow,
  kind: "credit" | "held-paid-seat" | "incident-no-show-claim",
) {
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

type UnsentPlan = {
  id: string;
  status: AppointmentStatus;
  planEndsAt: Date | null;
  schedulingPeriodStartsAt: Date;
  schedulingTimezone: string;
  subscriptionPlan: { durationInMonths: number };
} | null;

/**
 * What ops must know about a session-count remedy's plan: a live plan gets the
 * sessions back on a void, and once over its end refund waits on this one; a
 * settled plan was paid without them, so the refund is still owed.
 */
function planNote(
  sessionsRemoved: number | null,
  plan: UnsentPlan,
  now: Date,
): string {
  if (!sessionsRemoved || !plan) return "";
  if (!LIVE_SUBSCRIPTION_STATUSES.includes(plan.status))
    return " The plan settled without these sessions, so this refund is still owed: retry it.";
  const back =
    sessionsRemoved === 1
      ? " 1 session goes back to the plan if you void this refund."
      : ` ${sessionsRemoved} sessions go back to the plan if you void this refund.`;
  if (!subscriptionIsOver(plan, now)) return back;
  return `${back} The plan end is waiting for this refund: retry it or void it.`;
}

/** The plan and refund refs behind a session-count remedy, for the item's details. */
function planRefs(
  sessionsRemoved: number | null,
  plan: UnsentPlan,
  recommendationId: string,
): string | null {
  if (!sessionsRemoved || !plan) return null;
  return `Plan ${plan.id} · refund ${recommendationId}`;
}

/**
 * Support remedies approved without a live refund: the refund was refused,
 * failed at the gateway, or never ran. Each needs a retry or a void on its case;
 * for a session-count remedy the note says what each does to the plan.
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
      sessionsRemoved: true,
      decidedAt: true,
      createdAt: true,
      refund: { select: { status: true } },
      supportCase: { select: { referenceNumber: true } },
      payment: {
        select: {
          appointment: {
            select: {
              subscription: {
                select: {
                  id: true,
                  status: true,
                  planEndsAt: true,
                  schedulingPeriodStartsAt: true,
                  schedulingTimezone: true,
                  subscriptionPlan: { select: { durationInMonths: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    message: `Support case ${row.supportCase.referenceNumber}: an approved refund of ${inr(Number(row.amountPaise))} ${row.refund ? "failed" : "was never sent"}. Retry or void it on the case.${planNote(row.sessionsRemoved, row.payment.appointment?.subscription ?? null, now)}`,
    details: planRefs(
      row.sessionsRemoved,
      row.payment.appointment?.subscription ?? null,
      row.id,
    ),
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

/** One held top-up as it stands: what it still owes and what its hold allows. */
export type TopUpStatus = {
  ref: string;
  createdAt: Date;
  paymentId: string;
  heldKey: string;
  /** Still owed to the buyer; zero or less once refunds cover it. */
  owed: number;
  /** An older refund still stamped on the payment, which a hand refund settles first. */
  older: number;
  /** Its OPERATOR hold is still active. */
  holding: boolean;
  /** Another top-up on the same payment (so on the same earnings) is still unpaid. */
  otherUnpaid: boolean;
};

type TopUpDb = Pick<Tx, "systemEvent" | "payment" | "refund" | "earningsHold">;

/** Every held top-up recorded on these payments, as it stands, read on `db`. */
export async function topUpStatuses(
  db: TopUpDb,
  paymentIds: readonly string[],
): Promise<Map<string, TopUpStatus>> {
  const ids = [...new Set(paymentIds)];
  if (ids.length === 0) return new Map();
  const events = await db.systemEvent.findMany({
    where: {
      category: "PAYMENT",
      OR: ids.map((id) => ({
        correlationId: { startsWith: `${OWED_ALREADY_HELD_PREFIX}${id}:` },
      })),
    },
    orderBy: { createdAt: "asc" },
    select: EVENT_SELECT,
  });
  const first = new Map<string, OpenTopUp>();
  for (const e of events) {
    const ctx = owedHeldContextSchema.safeParse(e.context);
    if (!e.correlationId || !ctx.success || first.has(e.correlationId))
      continue;
    first.set(e.correlationId, { ...ctx.data, createdAt: e.createdAt });
  }
  if (first.size === 0) return new Map();
  const payments = await db.payment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      amount: true,
      refundOwedKey: true,
      refundOwedPaise: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const byPayment = new Map(payments.map((p) => [p.id, p]));
  const refunds = await db.refund.findMany({
    where: { paymentId: { in: ids }, status: { in: ["SUCCEEDED", "PENDING"] } },
    select: {
      paymentId: true,
      dedupeKey: true,
      createdAt: true,
      amountPaise: true,
      metadata: true,
    },
  });
  const activeHolds = await db.earningsHold.findMany({
    where: {
      reason: EarningsHoldReason.OPERATOR,
      sourceRef: { in: [...first.keys()] },
      releasedAt: null,
    },
    select: { sourceRef: true },
  });
  const held = new Set(activeHolds.map((h) => h.sourceRef));
  const still = stillOwedFifo(first, refunds);
  const statuses = new Map<string, TopUpStatus>();
  for (const [ref, t] of first) {
    const payment = byPayment.get(t.paymentId);
    const owed = Math.min(
      still.get(ref) ?? 0,
      payment ? refundableBalancePaise(Number(payment.amount), payment) : 0,
    );
    const older =
      payment?.refundOwedKey === t.heldKey && payment.refundOwedPaise !== null
        ? Number(payment.refundOwedPaise)
        : 0;
    statuses.set(ref, {
      ref,
      createdAt: t.createdAt,
      paymentId: t.paymentId,
      heldKey: t.heldKey,
      owed,
      older,
      holding: held.has(ref),
      otherUnpaid: false,
    });
  }
  for (const s of statuses.values()) {
    s.otherUnpaid = [...statuses.values()].some(
      (o) => o.ref !== s.ref && o.paymentId === s.paymentId && o.owed > 0,
    );
  }
  return statuses;
}

/** The row's instruction: the top-up (behind any still-owed older refund), or its hold release. */
function topUpRowCopy(s: TopUpStatus): string {
  if (s.owed <= 0) {
    return s.otherUnpaid
      ? "the top-up is settled; its hold is released once the other top-up on this payment is paid."
      : "the top-up is settled; release its hold.";
  }
  const topUp = handTopUpCopy(s.owed, s.holding);
  if (s.older <= 0) return topUp;
  return `${topUp} The older refund of ${inr(s.older)} is still owed and a hand refund settles it first, so refund ${inr(s.owed + s.older)} in total.`;
}

function topUpItem(s: TopUpStatus) {
  return {
    id: `owed-held:${s.ref}`,
    message: `Payment ${s.paymentId} (${s.heldKey}): ${topUpRowCopy(s)}`,
    createdAt: s.createdAt,
    paymentId: s.paymentId,
    occurrenceId: null,
    unitPaise: null,
    /** The Issue-refund preset: the top-up, plus an older refund a hand refund settles first; null once only the hold is left. */
    amountPaise: s.owed > 0 ? s.owed + s.older : null,
    /** The hold its release door takes, once the money is paid and no other top-up on the payment is open. */
    holdRef: s.ref,
    releasable: s.owed <= 0 && s.holding && !s.otherUnpaid,
    kind: "owed-already-held" as const,
    caseId: null,
    creditPlan: false,
  };
}

/** Held top-ups older than this leave the list unless their hold is still active; the runbook's triage query finds the rest. */
export const OWED_HELD_WINDOW_DAYS = 180;
const OWED_HELD_READ_LIMIT = 500;
/** Events read per page, and the most one read scans before saying more are waiting. */
const OWED_HELD_PAGE = 500;
const OWED_HELD_SCAN_CAP = 5_000;

/**
 * Doors whose refund another door's owed refund already held (first writer
 * wins). Open while money is still owed: refunds landed on the payment since
 * the event (oldest top-up first; never a holding refund, nor a hand refund's
 * share that settled one) cover less than the top-up, and the payment still has
 * a refundable balance. Any later refund on the payment counts, whatever its
 * reason. Once paid, the row asks for its own hold to be released. Settled
 * events are skipped before the display bound, so a reload always reaches the
 * next open one.
 */
export async function readOwedAlreadyHeld(
  now = new Date(),
  limit = OWED_HELD_READ_LIMIT,
) {
  const rows: ReturnType<typeof topUpItem>[] = [];
  const seen = new Set<string>();
  const collect = async (events: EventRow[]) => {
    const paymentIds = events.flatMap((e) => {
      const ctx = owedHeldContextSchema.safeParse(e.context);
      return ctx.success ? [ctx.data.paymentId] : [];
    });
    const statuses = await topUpStatuses(prisma, paymentIds);
    for (const e of events) {
      const status = e.correlationId ? statuses.get(e.correlationId) : null;
      if (!status || seen.has(status.ref)) continue;
      seen.add(status.ref);
      if (status.owed > 0 || status.holding) rows.push(topUpItem(status));
    }
  };
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
  if (holdRefs.length > 0) {
    await collect(
      await prisma.systemEvent.findMany({
        where: { correlationId: { in: holdRefs.map((h) => h.sourceRef) } },
        orderBy: { createdAt: "asc" },
        select: EVENT_SELECT,
      }),
    );
  }
  // The window, oldest first, page by page until enough open rows are found.
  const window = {
    category: "PAYMENT",
    createdAt: {
      gte: new Date(now.getTime() - OWED_HELD_WINDOW_DAYS * 86_400_000),
    },
    correlationId: { startsWith: OWED_ALREADY_HELD_PREFIX },
  };
  let cursor: string | null = null;
  let scanned = 0;
  let exhausted = false;
  while (rows.length <= limit && scanned < OWED_HELD_SCAN_CAP) {
    const page: EventRow[] = await prisma.systemEvent.findMany({
      where: window,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: OWED_HELD_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: EVENT_SELECT,
    });
    scanned += page.length;
    await collect(page);
    if (page.length < OWED_HELD_PAGE) {
      exhausted = true;
      break;
    }
    cursor = page[page.length - 1].id;
  }
  const shown = rows.slice(0, limit);
  if (exhausted && rows.length <= limit) return shown;
  return [
    ...shown,
    {
      id: "owed-held:more",
      message:
        "More held top-ups are waiting beyond these. Settle the rows above, then reload.",
      createdAt: now,
      paymentId: null,
      occurrenceId: null,
      unitPaise: null,
      amountPaise: null,
      holdRef: null,
      releasable: false,
      kind: "owed-already-held" as const,
      caseId: null,
      creditPlan: false,
    },
  ];
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
  // A no-show claim refunded and struck inside an incident: reviewed by hand, listed for 30 days.
  const incidentClaims = await prisma.systemEvent.findMany({
    where: {
      correlationId: { startsWith: INCIDENT_NO_SHOW_CLAIM_PREFIX },
      createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    select: EVENT_SELECT,
  });
  const stuck = await readStuckOwedRefunds();
  const owedHeld = await readOwedAlreadyHeld();
  const unsent = await readUnsentSupportRefunds();
  const items = [
    ...credit,
    ...held,
    ...incidentClaims.map((e) => toItem(e, "incident-no-show-claim")),
    ...stuck,
    ...owedHeld,
    ...unsent,
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return items;
}
