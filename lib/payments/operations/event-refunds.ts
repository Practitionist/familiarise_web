import { reportSentryError } from "@/lib/observability/report";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import {
  recordSystemEvent,
  recordSystemErrorSafe,
} from "@/lib/enterprise/system-events";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { seatRemovalRefundReason } from "./refund-cause";
import { notificationScope } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS, sendRefundProcessedEmail } from "@/lib/email";
import { refundBookingPayment } from "./booking-refund";
import { RefundValidationError } from "./refund";
import {
  driveRefundOwed,
  heldMarkerRefusal,
  markerFromRow,
  REFUND_OWED_SELECT,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "./refund-owed";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  isFreeCreditIntent,
  isPriceFreePayment,
  type FundingRail,
} from "@/lib/payments/funding-rail";
import { computeRefundPct } from "./cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "./cancellation-policy-store";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";
import { liveParticipant } from "@/lib/booking/participants";
import {
  seatLedgerFrom,
  seatSessionsByAppointment,
  occurrenceRefundsByPayment,
  seriesCancelRefundPaise,
  classEndRefundPaise,
  CLASS_END_REFUND_KEY_PREFIX,
  type SeriesSeat,
} from "@/lib/booking/class-series";

/**
 * Whole-event refund: every attendee of a cancelled class or
 * webinar is refunded through the booking front door, one keyed refund per
 * seat, so each rail (gateway, in-ledger org funding, credits) settles exactly
 * as a single booking would.
 *
 * The seats are stamped owed in the cancelling commit
 * ({@link stampWholeEventRefundsOwed}), which owns every seat's marker or
 * refuses with nothing committed, and this drives a bounded bite of them
 * inline; the retry-auto-refunds sweep drains the rest, so a large roster never
 * outlives the request.
 */

export type WholeEventRefundSummary = {
  refundsIssued: number;
  refundedPaise: number;
  childRefundIds: string[];
  failures: { paymentId: string; error: string }[];
  /** Seats whose balance was already fully refunded — a re-run, not an error. */
  skippedAlreadyRefunded: number;
  /** Seats stamped owed but left for the retry sweep once the inline bite was spent. */
  deferred: number;
  /** Seats nobody paid for: settled with nothing owed, never "already refunded". */
  freeSeats: number;
  /** Every seat was a skip and at least one had been refunded: nothing issued, deferred or failed. */
  alreadyRefunded: boolean;
  /** Every seat was free, so there was nothing to refund. */
  nothingToRefund: boolean;
};

/** Seats refunded inline before the rest is left to the retry sweep. */
const INLINE_SEAT_LIMIT = 10;
const INLINE_BUDGET_MS = 10_000;

function isPriceFreeSeat(p: {
  paymentIntent: string;
  amount: number | bigint;
  originalAmount: number | bigint;
}): boolean {
  return isPriceFreePayment({
    paymentIntent: p.paymentIntent,
    amountPaise: Number(p.amount),
    listPricePaise: Number(p.originalAmount),
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type EventSeatPlan =
  | { kind: "owe"; marker: RefundOwedMarker }
  | { kind: "settled"; free?: true }
  | { kind: "escalate"; delivered: number; partlyReturned: boolean };

type EventRefundArgs = {
  kind: "class" | "webinar";
  eventId: string;
  reason: string;
  /**
   * #1780 D-5 — per-seat class ledgers read BEFORE the cancel tombstoned the
   * sessions (classSeriesLedgers); each seat then refunds only what was not
   * delivered. Absent (a webinar, a moderation sweep) → every seat in full.
   */
  ledgers?: ReadonlyMap<string, SeriesSeat>;
  /** Scopes the seat keys to the calling door, so two doors never share one refund. */
  dedupeKeyPrefix?: string;
  /**
   * What a seat with a ledger is owed: everything undelivered (a cancel, the
   * default) or only the sessions sold but never placed (class-end settlement).
   */
  basis?: "undelivered" | "unplaced";
};

/**
 * What each SUCCEEDED seat of the event is owed, read on `db`: the undelivered
 * share clamped to the remaining balance, a whole credit restoration, a skip
 * when nothing is left, or an escalation the credits rail cannot pay. A seat
 * already released settled its money on the way out, so it is owed nothing.
 */
async function planEventSeats(
  db: PrismaLike,
  args: EventRefundArgs,
): Promise<{ plans: Map<string, EventSeatPlan>; currency: string }> {
  const prefix = args.dedupeKeyPrefix ?? "event-cancel";
  const eventFilter =
    args.kind === "webinar"
      ? { webinarId: args.eventId }
      : { classId: args.eventId };
  const payments = await db.payment.findMany({
    where: {
      appointment: eventFilter,
      paymentStatus: "SUCCEEDED",
      // Retired rows stay out: the front door refuses them.
      deletedAt: null,
    },
    select: {
      id: true,
      userId: true,
      amount: true,
      originalAmount: true,
      currency: true,
      paymentIntent: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const liveSeats = await liveSeatPayments(db, eventFilter, payments);
  const creditStates = await creditSeatStates(
    db,
    payments
      .filter((p) => isFreeCreditIntent(p.paymentIntent))
      .map((p) => p.id),
  );
  const unplacedBasis = args.basis === "unplaced";
  const classEndPaid = unplacedBasis
    ? await classEndRefundedPaise(db, args.eventId)
    : new Map<string, number>();
  const plans = new Map<string, EventSeatPlan>();
  for (const p of payments) {
    // A free seat owes nothing and writes no refund record.
    if (isPriceFreeSeat(p)) {
      plans.set(p.id, { kind: "settled", free: true });
      continue;
    }
    if (!liveSeats.has(p.id)) {
      plans.set(p.id, { kind: "settled" });
      continue;
    }
    const ledger = args.ledgers?.get(p.id);
    // Class-end settlement owes only a seat whose ledger shows unplaced sessions.
    if (unplacedBasis && !(ledger && ledger.unplaced > 0)) {
      plans.set(p.id, { kind: "settled" });
      continue;
    }
    const key = `${prefix}:${args.eventId}:pay:${p.id}`;
    const credit = creditStates.get(p.id);
    if (credit) {
      // The credits rail restores whole or not at all, so a seat delivered part
      // of the series, or already partly returned, is escalated to a human.
      const partOwed =
        unplacedBasis && !!ledger && ledger.unplaced < ledger.heldCount;
      if (credit.claimed && credit.stillUsedPaise <= 0) {
        plans.set(p.id, { kind: "settled" });
      } else if (
        (ledger && ledger.deliveredHeld > 0) ||
        credit.claimed ||
        partOwed
      ) {
        plans.set(p.id, {
          kind: "escalate",
          delivered: ledger?.deliveredHeld ?? 0,
          partlyReturned: credit.claimed,
        });
      } else {
        plans.set(p.id, {
          kind: "owe",
          marker: {
            paymentId: p.id,
            amountPaise: null,
            key,
            reason: args.reason,
          },
        });
      }
      continue;
    }
    const balance = refundableBalancePaise(Number(p.amount), p);
    const owed = Math.min(
      seatOwedPaise(ledger, p, balance, classEndPaid, unplacedBasis),
      balance,
    );
    plans.set(
      p.id,
      owed > 0
        ? {
            kind: "owe",
            marker: {
              paymentId: p.id,
              amountPaise: owed,
              key,
              reason: args.reason,
            },
          }
        : { kind: "settled" },
    );
  }
  // Settlement is INR-only by design, so the seats of one event share a currency.
  return { plans, currency: payments[0]?.currency ?? "INR" };
}

/**
 * A money seat's share before the balance clamp: its unplaced sessions net of
 * any class-end refund already paid, or everything undelivered net of the
 * sessions already refunded one by one (`occ:*`); the whole balance with no ledger.
 */
function seatOwedPaise(
  ledger: SeriesSeat | undefined,
  payment: { id: string; amount: bigint | number },
  balance: number,
  classEndPaid: ReadonlyMap<string, number>,
  unplacedBasis: boolean,
): number {
  if (!ledger) return balance;
  if (unplacedBasis) {
    return (
      Number(classEndRefundPaise(ledger, payment.amount)) -
      (classEndPaid.get(payment.id) ?? 0)
    );
  }
  return (
    Number(seriesCancelRefundPaise(ledger, payment.amount)) -
    (ledger.occRefundedPaise ?? 0)
  );
}

/** Class-end refunds already sent or in flight on the class, by payment. */
async function classEndRefundedPaise(
  db: PrismaLike,
  classId: string,
): Promise<Map<string, number>> {
  const rows = await db.refund.findMany({
    where: {
      status: { in: ["SUCCEEDED", "PENDING"] },
      dedupeKey: { startsWith: `${CLASS_END_REFUND_KEY_PREFIX}${classId}:` },
    },
    select: { paymentId: true, amountPaise: true },
  });
  const paid = new Map<string, number>();
  for (const r of rows) {
    paid.set(r.paymentId, (paid.get(r.paymentId) ?? 0) + Number(r.amountPaise));
  }
  return paid;
}

/**
 * The cancel preview's answer, from the same plan the cancel stamps: the cash
 * it would pay back and how many seats are owed something.
 */
export async function quoteWholeEventRefunds(
  kind: "class" | "webinar",
  eventId: string,
  ledgers: ReadonlyMap<string, SeriesSeat> | null,
): Promise<{ owedPaise: number; seats: number; currency: string }> {
  const { plans, currency } = await planEventSeats(prisma, {
    kind,
    eventId,
    reason: "preview",
    ledgers: ledgers ?? undefined,
  });
  let owedPaise = 0;
  let seats = 0;
  for (const plan of plans.values()) {
    if (plan.kind === "settled") continue;
    seats += 1;
    if (plan.kind === "owe") owedPaise += plan.marker.amountPaise ?? 0;
  }
  return { owedPaise, seats, currency };
}

/**
 * The payments that still fund a live seat on the event: the seat row linked
 * to the payment, or a legacy unlinked seat of the same buyer.
 */
async function liveSeatPayments(
  db: PrismaLike,
  eventFilter: { webinarId: string } | { classId: string },
  payments: readonly { id: string; userId: string }[],
): Promise<Set<string>> {
  if (payments.length === 0) return new Set();
  const seats = await db.appointmentParticipant.findMany({
    where: {
      appointment: eventFilter,
      ...liveParticipant(),
      OR: [
        { paymentId: { in: payments.map((p) => p.id) } },
        { paymentId: null, userId: { in: payments.map((p) => p.userId) } },
      ],
    },
    select: { userId: true, paymentId: true },
  });
  return new Set(
    payments
      .filter((p) =>
        seats.some(
          (s) =>
            s.paymentId === p.id ||
            (s.paymentId === null && s.userId === p.userId),
        ),
      )
      .map((p) => p.id),
  );
}

/**
 * Stamps every owed seat of the event on the caller's transaction, in one
 * statement, so the commit that cancels the event also records what it owes.
 * Every seat's marker must be this door's: a seat whose payment already owes
 * another door's refund refuses the whole cancel, so the caller commits nothing.
 */
export async function stampWholeEventRefundsOwed(
  tx: Tx,
  args: EventRefundArgs,
): Promise<Map<string, EventSeatPlan>> {
  const { plans } = await planEventSeats(tx, args);
  const markers = [...plans.values()].flatMap((plan) =>
    plan.kind === "owe" ? [plan.marker] : [],
  );
  if ((await stampRefundsOwed(tx, markers)) < markers.length) {
    await assertOwnsEveryMarker(tx, markers, args);
  }
  return plans;
}

/**
 * After a short batch stamp: a replay of this door's own key is owned; any
 * other marker (or none) on an owed seat refuses with the held-marker answer.
 */
async function assertOwnsEveryMarker(
  tx: Tx,
  markers: readonly RefundOwedMarker[],
  args: EventRefundArgs,
): Promise<void> {
  const rows = await tx.payment.findMany({
    where: { id: { in: markers.map((m) => m.paymentId) } },
    select: { id: true, refundOwedKey: true },
  });
  const held = new Map(rows.map((r) => [r.id, r.refundOwedKey]));
  const lost = markers.find((m) => held.get(m.paymentId) !== m.key);
  if (!lost) return;
  throw await heldMarkerRefusal(
    tx,
    lost.paymentId,
    { eventId: args.eventId, kind: args.kind, key: lost.key },
    args.kind,
  );
}

export async function refundWholeEventPayments(
  kind: "class" | "webinar",
  eventId: string,
  reason: string,
  initiatedByUserId: string | null,
  opts: {
    ledgers?: ReadonlyMap<string, SeriesSeat>;
    dedupeKeyPrefix?: string;
    /**
     * The plans the cancelling commit stamped. That commit released every
     * seat, so a fresh plan would read them all as already settled.
     */
    plans?: ReadonlyMap<string, EventSeatPlan>;
  } = {},
): Promise<WholeEventRefundSummary> {
  const summary: WholeEventRefundSummary = {
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
    skippedAlreadyRefunded: 0,
    deferred: 0,
    freeSeats: 0,
    alreadyRefunded: false,
    nothingToRefund: false,
  };
  const { plans: stamped, ...rest } = opts;
  const args: EventRefundArgs = { kind, eventId, reason, ...rest };

  const plans =
    stamped ??
    (await prisma.$transaction((tx) => stampWholeEventRefundsOwed(tx, args)));
  if (plans.size === 0) return summary;

  const owing: string[] = [];
  for (const [paymentId, plan] of plans) {
    if (plan.kind === "settled" && plan.free) {
      summary.freeSeats += 1;
    } else if (plan.kind === "settled") {
      summary.skippedAlreadyRefunded += 1;
    } else if (plan.kind === "escalate") {
      summary.failures.push({
        paymentId,
        error:
          "partial credit restoration after delivered sessions needs a human",
      });
      await escalatePartialCredit(paymentId, {
        eventId,
        kind,
        delivered: plan.delivered,
        partlyReturned: plan.partlyReturned,
      });
    } else {
      owing.push(paymentId);
    }
  }

  const ownKeys = owing.flatMap((paymentId) => {
    const plan = plans.get(paymentId);
    return plan?.kind === "owe" ? [plan.marker.key] : [];
  });
  const [rows, disputes] = await Promise.all([
    // Only this door's own markers: another door's later marker is that door's to drive.
    prisma.payment.findMany({
      where: { id: { in: owing }, refundOwedKey: { in: ownKeys } },
      orderBy: { refundOwedAt: "asc" },
      select: REFUND_OWED_SELECT,
    }),
    prisma.dispute.findMany({
      where: {
        paymentId: { in: owing },
        status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
      },
      select: { paymentId: true, status: true },
    }),
  ]);
  const disputed = new Map(disputes.map((d) => [d.paymentId, d.status]));
  const markers = rows.flatMap((row) => markerFromRow(row) ?? []);
  // A seat planned owed whose own marker is already gone was settled by a racing drive.
  summary.skippedAlreadyRefunded += owing.length - markers.length;

  const deadline = Date.now() + INLINE_BUDGET_MS;
  let driven = 0;
  let firstError: unknown;
  for (const marker of markers) {
    const dispute = disputed.get(marker.paymentId);
    if (dispute) {
      // The marker waits for the dispute; the sweep skips it until it resolves.
      summary.failures.push({
        paymentId: marker.paymentId,
        error: `Payment ${marker.paymentId} has an open dispute (${dispute}); resolve it before refunding`,
      });
      continue;
    }
    if (driven >= INLINE_SEAT_LIMIT || Date.now() >= deadline) {
      summary.deferred += 1;
      continue;
    }
    driven += 1;
    const outcome = await driveRefundOwed(marker, { initiatedByUserId });
    switch (outcome.kind) {
      case "refunded":
        summary.refundsIssued += 1;
        summary.refundedPaise += outcome.refund.amountRefundedPaise;
        summary.childRefundIds.push(outcome.refund.refundId);
        break;
      case "replayed":
      case "settled":
        summary.skippedAlreadyRefunded += 1;
        break;
      case "blocked":
        summary.failures.push({
          paymentId: marker.paymentId,
          error: `Payment ${marker.paymentId} has an open dispute; resolve it before refunding`,
        });
        break;
      case "failed":
        firstError ??= outcome.error;
        summary.failures.push({
          paymentId: marker.paymentId,
          error: errMsg(outcome.error),
        });
        break;
    }
  }
  // One Sentry event per call, never per seat.
  if (firstError !== undefined) {
    reportSentryError(firstError, {
      subsystem: "payments",
      tags: { feature: "whole-event-refund" },
      extra: { eventId, kind, failed: summary.failures.length },
    });
  }

  const allSkipped =
    summary.refundsIssued === 0 &&
    summary.failures.length === 0 &&
    summary.deferred === 0 &&
    summary.skippedAlreadyRefunded + summary.freeSeats === plans.size;
  summary.nothingToRefund = allSkipped && summary.freeSeats === plans.size;
  summary.alreadyRefunded = allSkipped && summary.skippedAlreadyRefunded > 0;

  return summary;
}

/**
 * Each paid class seat's ledger by payment id, joined at the later of its
 * participant row and its payment (a re-bought seat reuses the row). At most
 * five reads on `db` whatever the roster, so a door's transaction stays short.
 */
export async function classSeriesLedgers(
  classId: string,
  db: PrismaLike = prisma,
): Promise<Map<string, SeriesSeat>> {
  const payments = await db.payment.findMany({
    where: {
      appointment: { classId },
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      userId: true,
      createdAt: true,
      appointmentId: true,
    },
  });
  const ledgers = new Map<string, SeriesSeat>();
  if (payments.length === 0) return ledgers;
  const seats = await db.appointmentParticipant.findMany({
    where: {
      appointment: { classId },
      userId: { in: payments.map((p) => p.userId) },
    },
    select: { userId: true, createdAt: true, sessionsPurchased: true },
  });
  const placed = payments.flatMap((p) =>
    p.appointmentId ? [{ ...p, appointmentId: p.appointmentId }] : [],
  );
  const sessions = await seatSessionsByAppointment(
    db,
    placed.map((p) => p.appointmentId),
  );
  const refunded = await occurrenceRefundsByPayment(
    db,
    placed.map((p) => p.id),
  );
  const now = new Date();
  for (const p of placed) {
    const seat = seats.find((s) => s.userId === p.userId);
    const seatAt = seat?.createdAt;
    const { N, occurrences } = sessions.get(p.appointmentId) ?? {
      N: 0,
      occurrences: [],
    };
    ledgers.set(p.id, {
      ...seatLedgerFrom({
        N,
        amountPaise: p.amount,
        joinedAt: seatAt && seatAt > p.createdAt ? seatAt : p.createdAt,
        occurrences,
        now,
        sessionsPurchased: seat?.sessionsPurchased,
      }),
      occRefundedPaise: refunded.get(p.id) ?? 0,
    });
  }
  return ledgers;
}

/** The dedupe prefix of class-end settlement; each seat's key is `class-end:<classId>:pay:<paymentId>`. */
const CLASS_END_DEDUPE_PREFIX = CLASS_END_REFUND_KEY_PREFIX.slice(0, -1);

/** What class-end settlement stamped: seats owed a refund, and credit seats queued for a human. */
export type ClassEndSettlement = {
  owed: number;
  owedPaise: number;
  escalated: number;
};

/**
 * Class-end settlement, on the completing transaction: every live paid seat is
 * stamped owed floor(paid × unplaced / sessions sold) for the sessions it was
 * sold but no row ever placed, net of any class-end refund already paid, and a
 * credit seat owed part of its value is queued for a human in the same commit.
 * Nothing is driven here: the retry-auto-refunds sweep drives the markers, and
 * each marker holds its payment's earnings until the refund settles. A seat
 * whose payment owes another door's refund refuses, so the completion commits nothing.
 */
export async function stampClassEndRefundsOwed(
  tx: Tx,
  classId: string,
): Promise<ClassEndSettlement> {
  const plans = await stampWholeEventRefundsOwed(tx, {
    kind: "class",
    eventId: classId,
    reason: "class ended with sessions that were never scheduled",
    ledgers: await classSeriesLedgers(classId, tx),
    dedupeKeyPrefix: CLASS_END_DEDUPE_PREFIX,
    basis: "unplaced",
  });
  const settlement: ClassEndSettlement = {
    owed: 0,
    owedPaise: 0,
    escalated: 0,
  };
  for (const [paymentId, plan] of plans) {
    if (plan.kind === "owe") {
      settlement.owed += 1;
      settlement.owedPaise += plan.marker.amountPaise ?? 0;
    } else if (plan.kind === "escalate") {
      settlement.escalated += 1;
      await recordSystemEvent({
        db: tx,
        strict: true,
        category: "BOOKING",
        severity: "WARN",
        message: `Credit seat ${paymentId} needs a partial credit return`,
        context: {
          paymentId,
          eventId: classId,
          kind: "class",
          delivered: plan.delivered,
          partlyReturned: plan.partlyReturned,
          cause: "class-end",
        },
        correlationId: `partial-credit:${paymentId}`,
      });
    }
  }
  return settlement;
}

/**
 * Refund ONE attendee's seat when the organiser removes them from a live
 * class/webinar (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of an event and keep the fee,
 * with no refund, no earnings reversal and no notice to the attendee. The
 * moderation bulk-cancel has always refunded a removed attendee in full; the
 * interactive endpoints were the outlier.
 *
 * ## Who initiated the removal matters for the % (#1005)
 *
 * Historically only organisers hit this helper, so it always passed
 * `isConsultantInitiated: true` into `computeRefundPct` (full
 * `consultantInitiatedPct`, clock ignored). Self-leave reused that path and
 * paid out organiser-fault money even after the session had started — the
 * dialog copy promised "under the event's cancellation policy", which is the
 * attendee notice tiers.
 *
 * Default remains `"organiser"` so existing roster/moderation callers keep the
 * full-refund behaviour without an explicit flag. Self-leave must pass
 * `"attendee"` and we resolve `hoursUntilStart` from the next future live slot
 * (`startsAt >= now`) so a mid-program class leave uses the upcoming session,
 * not a past COMPLETED/UNVERIFIED row that would force 0%.
 *
 * Never throws: the roster change has already committed.
 */
export async function refundRemovedAttendeeSeat(args: {
  kind: "class" | "webinar";
  eventId: string;
  attendeeUserId: string;
  initiatedByUserId: string | null;
  /**
   * Defaults to organiser (full tier). Pass `"attendee"` for consultee
   * self-leave so notice-window tiers apply.
   */
  initiatedBy?: "organiser" | "attendee";
  /**
   * #1780 — the seat-leave rule's answer (lib/booking/seat-leave.ts): `full`
   * refunds 100 % with no ladder; a class quote arrives as `amountPaise`.
   */
  mode?: "full";
  amountPaise?: number;
  /** #1780 — the seat's key; the payment id is appended (a re-bought seat is a new sale). */
  dedupeKey?: string;
  /**
   * The sale this refund is for, when the caller already knows it.
   *
   * Absent, the payment is re-derived below — which is the right answer for the
   * roster doors, where the actor names a SEAT and the rule is deliberately
   * "the one they bought first". It is the wrong answer for a capture that has
   * already landed on a known Payment: the capture's own seat is the NEWEST
   * participant row (pre-#1319 data holds one row per session appointment, so
   * `confirmSeatAfterCapture` re-reads newest-first), and on a class whose
   * legacy rows still carry a session payment apiece the re-derivation answers
   * with a DIFFERENT payment — refunding money the capture never took and
   * leaving the captured money with the buyer, on a seat that is not there.
   *
   * Addressing the payment by id keeps every rail decision below intact (credit
   * restoration, the org wallet/invoice/licence reversal, the gateway phases and
   * the attendee notice) — only the SELECT changes. It is still scoped to the
   * event and the buyer, so a payment for some other seat cannot be reached
   * through it.
   */
  paymentId?: string;
}): Promise<{
  amountRefundedPaise: number;
  refundPct: number;
  /**
   * Which rail returned the seat fee, or null when nothing moved. The
   * organiser's toast has to say where the money went, and only the gateway
   * rail reaches the attendee — an org-funded seat returns to the sponsor's
   * wallet, accrual or licence, which the attendee never held.
   */
  rail: FundingRail | null;
  /** Set when the seat was free: nothing was paid, so nothing is refunded. */
  freeBooking?: true;
  /** The gateway is still settling the refund. */
  pending?: boolean;
} | null> {
  const eventFilter =
    args.kind === "webinar"
      ? { webinarId: args.eventId }
      : { classId: args.eventId };
  // Missing flag = legacy organiser path; do not flip the money default.
  const isOrganiserInitiated =
    (args.initiatedBy ?? "organiser") === "organiser";

  // Hoisted so the catch can scope its ops event to the funding organisation;
  // a failure reported against `null` never reaches the org that is owed it.
  let organizationId: string | null = null;

  try {
    const payment = await prisma.payment.findFirst({
      // Deterministic: the seat they bought first is the one being released —
      // unless the caller named the sale, which is the only way this door can
      // be sure it is refunding the payment in front of it.
      ...(args.paymentId ? {} : { orderBy: { createdAt: "asc" } }),
      where: {
        ...(args.paymentId ? { id: args.paymentId } : {}),
        userId: args.attendeeUserId,
        appointment: eventFilter,
        paymentStatus: "SUCCEEDED",
        // #1780 decision 11 — credit-funded (free_, amount 0) seats are in:
        // they restore credits under the same rule (see creditSeatRefund).
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        originalAmount: true,
        paymentIntent: true,
        currency: true,
        organizationId: true,
        ...REFUNDABLE_BALANCE_SELECT,
        appointment: { select: { cancellationPolicy: POLICY_TERMS_INCLUDE } },
      },
    });
    if (!payment) return null;
    // A free seat owes nothing and writes no refund record.
    if (isPriceFreeSeat(payment)) {
      return {
        amountRefundedPaise: 0,
        refundPct: 100,
        rail: null,
        freeBooking: true,
      };
    }
    organizationId = payment.organizationId;
    const dedupeKey = args.dedupeKey
      ? `${args.dedupeKey}:pay:${payment.id}`
      : undefined;
    if (isFreeCreditIntent(payment.paymentIntent)) {
      return await creditSeatRefund(args, payment.id, dedupeKey);
    }

    // Organiser branch ignores the clock inside computeRefundPct; skip the
    // slot lookup. Attendee branch needs a real hoursUntilStart — negative
    // means already started → 0% under the tiers (and the DELETE route should
    // have 400'd before we got here for self-leave).
    let hoursUntilStart = -1;
    if (!isOrganiserInitiated && args.mode === undefined) {
      hoursUntilStart = await hoursUntilNextLive(eventFilter);
    }

    const grossPaise = Number(payment.amount);
    const refundPct = seatRefundPct(args, grossPaise, () =>
      computeRefundPct(
        termsFromPolicyRow(payment.appointment?.cancellationPolicy),
        hoursUntilStart,
        isOrganiserInitiated,
      ),
    );
    // #1396 — `refundPct` may carry two decimals (a policy can say 12.5%), so
    // multiplying paise by the float first put a binary rounding error inside a
    // money amount before the floor ever ran. Scale to integer basis points and
    // divide once, exactly as `computeBookingRefundQuote` in cancellation-policy
    // does; BigInt because the intermediate product leaves the safe-integer
    // range long before the amounts stop being real money.
    const policyRefundPaise =
      args.amountPaise ??
      Number(
        (BigInt(grossPaise) * BigInt(Math.round(refundPct * 100))) /
          BigInt(10_000),
      );
    // Clamp to the remaining balance, exactly as the cancel route does. A seat
    // carrying an earlier partial refund would otherwise ask for more than is
    // left, `refundPayment` would reject the whole request, and the attendee
    // would receive nothing of the remainder they are owed.
    const amountPaise = Math.min(
      policyRefundPaise,
      refundableBalancePaise(grossPaise, payment),
    );
    if (amountPaise <= 0)
      return { amountRefundedPaise: 0, refundPct, rail: null };

    const result = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise,
      reason: seatRemovalRefundReason(
        args.kind,
        args.eventId,
        isOrganiserInitiated,
        refundPct,
      ),
      ...(isOrganiserInitiated
        ? { customerReason: `You were removed from this ${args.kind}.` }
        : {}),
      initiatedByUserId: args.initiatedByUserId,
      dedupeKey,
    });

    // Gateway refunds with status SUCCEEDED stage notices inside refundPayment
    // Phase 3b, and PENDING refunds wait for the settlement webhook.
    if (result.rail === "GATEWAY" && !result.status) {
      await Promise.allSettled([
        notifyRefundProcessed(
          args.attendeeUserId,
          {
            ...notificationScope(payment.organizationId),
            amount: amountPaise,
            currency: payment.currency,
            reason: isOrganiserInitiated
              ? `You were removed from this ${args.kind}.`
              : `You left this ${args.kind}.`,
            dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
          },
          isOrganiserInitiated
            ? {
                required: {
                  kind: "SEAT_RELEASED",
                  recipients: [args.attendeeUserId],
                },
              }
            : undefined,
        ),
        sendRefundProcessedEmail(
          {
            userId: args.attendeeUserId,
            paymentId: payment.id,
            amountPaise,
            currency: payment.currency,
            required: isOrganiserInitiated,
          },
          { budgetMs: EMAIL_BUDGET_MS.REQUEST },
        ),
      ]);
    }

    return {
      amountRefundedPaise: result.amountRefundedPaise,
      refundPct,
      rail: result.rail,
      // Still settling at the gateway: the removal notice says the refund started.
      ...(result.status === "PENDING" ? { pending: true } : {}),
    };
  } catch (err) {
    // Benign idempotent re-drives — a seat already refunded, or a payment that
    // never captured. Paging ops for these turns every repeat click into an
    // incident. Mirrors the overage credit-back exemption above.
    // AMOUNT_EXCEEDS_REFUNDABLE is unreachable through the clamp above, but a
    // concurrent refund settling between the read and the write can still
    // produce it, and that race is the benign case too.
    if (isBenignSeatRefundError(err))
      return { amountRefundedPaise: 0, refundPct: 0, rail: null };

    reportSentryError(err, {
      subsystem: "payments",
      tags: { feature: "attendee-removal-refund" },
      extra: { ...args },
    });
    void recordSystemErrorSafe({
      organizationId,
      category: "PAYMENT",
      summary: `Seat refund failed for attendee removed from ${args.kind} ${args.eventId}`,
      err,
      context: { ...args },
    });
    return { amountRefundedPaise: 0, refundPct: 0, rail: null };
  }
}

type SeatRefundArgs = Parameters<typeof refundRemovedAttendeeSeat>[0];

/** Hours to the next live session from now, or -1 when none is upcoming. */
async function hoursUntilNextLive(
  eventFilter: Parameters<typeof findLiveEventSlot>[0],
): Promise<number> {
  const now = new Date();
  // Next upcoming session — not the earliest historical live row.
  // Past class sessions stay SCHEDULED/COMPLETED/UNVERIFIED and would
  // otherwise pin hoursUntilStart negative → permanent 0% refund.
  const nextLive = await findLiveEventSlot(eventFilter, {
    order: "asc",
    startsAtGte: now,
  });
  if (!nextLive) return -1;
  return (nextLive.startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);
}

/** The idempotent re-drive refusals a seat refund swallows without paging. */
function isBenignSeatRefundError(err: unknown): boolean {
  return (
    err instanceof RefundValidationError &&
    (err.code === "ALREADY_FULLY_REFUNDED" ||
      err.code === "PAYMENT_NOT_SUCCEEDED" ||
      err.code === "AMOUNT_EXCEEDS_REFUNDABLE")
  );
}

/** The percentage a seat refund reports: the rule's answer, else the ladder. */
function seatRefundPct(
  args: SeatRefundArgs,
  grossPaise: number,
  ladder: () => number,
): number {
  if (args.amountPaise !== undefined) {
    return grossPaise > 0
      ? Math.round((args.amountPaise * 10_000) / grossPaise) / 100
      : 0;
  }
  return args.mode === "full" ? 100 : ladder();
}

/**
 * #1780 decision 11 — a credit-funded seat returns credits, not cash. The
 * credits rail restores whole or not at all (#1161), so a full answer (an
 * organiser removal, a leave outside the window, a host move) restores it
 * and a per-session answer is escalated to ops rather than over-restored.
 */
/** What the credits rail keys on: a restoration row, and credit still consumed. */
/** Whether each credit seat already has a restoration row, and how much credit it still holds. */
async function creditSeatStates(
  db: PrismaLike,
  paymentIds: string[],
): Promise<Map<string, { claimed: boolean; stillUsedPaise: number }>> {
  if (paymentIds.length === 0) return new Map();
  // Sequential: the cancel's transaction runs one statement at a time.
  const claims = await db.refund.findMany({
    where: {
      paymentId: { in: paymentIds },
      status: { in: ["SUCCEEDED", "PENDING"] },
    },
    select: { paymentId: true },
  });
  const usages = await db.referralCreditUsage.findMany({
    where: { paymentId: { in: paymentIds } },
    select: { paymentId: true, amount: true },
  });
  const claimed = new Set(claims.map((c) => c.paymentId));
  return new Map(
    paymentIds.map((id) => [
      id,
      {
        claimed: claimed.has(id),
        stillUsedPaise: usages
          .filter((u) => u.paymentId === id)
          .reduce((sum, u) => sum + Number(u.amount), 0),
      },
    ]),
  );
}

async function creditSeatState(paymentId: string) {
  const states = await creditSeatStates(prisma, [paymentId]);
  return states.get(paymentId) ?? { claimed: false, stillUsedPaise: 0 };
}

/** #1771 K-5 — a durable row the Refunds tab lists for the credit door. */
async function escalatePartialCredit(
  paymentId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await recordSystemEvent({
    category: "BOOKING",
    severity: "WARN",
    message: `Credit seat ${paymentId} needs a partial credit return`,
    context: { paymentId, ...context },
    correlationId: `partial-credit:${paymentId}`,
  });
}

async function creditSeatRefund(
  args: SeatRefundArgs,
  paymentId: string,
  dedupeKey: string | undefined,
): Promise<{
  amountRefundedPaise: number;
  refundPct: number;
  rail: FundingRail | null;
}> {
  const whole =
    (args.initiatedBy ?? "organiser") === "organiser" || args.mode === "full";
  // After an ops partial return the rail would refuse as "already refunded"
  // and the rest would be lost silently; queue it for the credit door instead.
  const state = await creditSeatState(paymentId);
  if (whole && state.claimed) {
    if (state.stillUsedPaise > 0) {
      await escalatePartialCredit(paymentId, {
        eventId: args.eventId,
        kind: args.kind,
        partlyReturned: true,
      });
    }
    return { amountRefundedPaise: 0, refundPct: 0, rail: "CREDITS" };
  }
  if (!whole) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: `Credit seat left ${args.kind} ${args.eventId} mid-series — per-session credit restoration needs a human`,
      err: new Error("CREDIT_SEAT_PARTIAL_RESTORE"),
      context: { ...args, paymentId },
    });
    return { amountRefundedPaise: 0, refundPct: 0, rail: null };
  }
  const organiser = (args.initiatedBy ?? "organiser") === "organiser";
  const r = await refundBookingPayment({
    paymentId,
    // The organiser's removal keeps its cause, so its credit notice is required.
    reason: organiser
      ? seatRemovalRefundReason(args.kind, args.eventId, true, 100)
      : `left ${args.kind} ${args.eventId} — credits restored in full`,
    initiatedByUserId: args.initiatedByUserId,
    dedupeKey,
  });
  return {
    amountRefundedPaise: r.amountRefundedPaise,
    refundPct: 100,
    rail: r.rail,
  };
}
