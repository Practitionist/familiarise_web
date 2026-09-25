/**
 * #1780 — leaving (or being removed from) a webinar or class seat: the rule,
 * the release and the refund, shared by both participant DELETE routes.
 *
 * The rule runs inside the Serializable transaction and BEFORE the seat is
 * released, on the transaction client, so a refusal rolls back and the seat
 * stays:
 *   - an organiser removal refunds in full, as it always has;
 *   - a webinar, or a class nobody has been delivered a session of yet, is
 *     refused inside the host's window (REFUND_WINDOW_CLOSED) and refunded in
 *     full outside it; a next session the host moved after the purchase
 *     waives the window (decision 6);
 *   - a class already under way refunds the class quote (D-4).
 * The refund runs after the commit through the seat front door, keyed
 * `seat-leave:<participantId>` so a repeat never refunds twice.
 */

import { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";
import {
  eventRefundWindowHours,
  quoteClassSeatRefund,
} from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
import { BookingRuleError } from "./booking-rule-error";
import {
  occurrenceRefundsPaise,
  seatLedger,
  seriesLedger,
  type SeatLedger,
} from "./class-series";
import { liveParticipant, releaseParticipant } from "./participants";

export type EventKind = "class" | "webinar";

/** What the refund after the commit should do; `sessions` is what a class seat gives up. */
export type SeatRefundPlan = ({ mode: "full" } | { amountPaise: number }) & {
  sessions?: number;
};

type Seat = {
  id: string;
  appointmentId: string;
  createdAt: Date;
  refundWindowHours: number | null;
};

const HOUR_MS = 3_600_000;

const eventFilter = (kind: EventKind, eventId: string) =>
  kind === "webinar" ? { webinarId: eventId } : { classId: eventId };

/** A session the host moved after this seat was bought (decision 6). */
export const movedAfter = (
  movedAt: Date | null | undefined,
  joinedAt: Date,
): boolean => !!movedAt && movedAt > joinedAt;

function windowClosed(windowHours: number): BookingRuleError {
  return new BookingRuleError(
    "REFUND_WINDOW_CLOSED",
    `Free cancellation ended ${windowHours} h before the start — this seat can no longer be refunded.`,
  );
}

/** Refuse inside the window unless the next session was moved on the buyer. */
function assertOutsideWindow(
  next: { startsAt: Date; movedAt: Date | null } | null | undefined,
  joinedAt: Date,
  windowHours: number,
  now: Date,
): void {
  if (!next || movedAfter(next.movedAt, joinedAt)) return;
  if ((next.startsAt.getTime() - now.getTime()) / HOUR_MS < windowHours) {
    throw windowClosed(windowHours);
  }
}

async function planWindowHours(
  tx: Tx,
  kind: EventKind,
  eventId: string,
): Promise<number | null> {
  if (kind === "webinar") {
    const w = await tx.webinar.findUnique({
      where: { id: eventId },
      select: { webinarPlan: { select: { refundWindowHours: true } } },
    });
    return w?.webinarPlan?.refundWindowHours ?? null;
  }
  const c = await tx.class.findUnique({
    where: { id: eventId },
    select: { classPlan: { select: { refundWindowHours: true } } },
  });
  return c?.classPlan?.refundWindowHours ?? null;
}

/** The seat's paid order on this event, read on the transaction client. */
function seatPayment(tx: Tx, kind: EventKind, eventId: string, userId: string) {
  return tx.payment.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      userId,
      appointment: eventFilter(kind, eventId),
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      createdAt: true,
      ...REFUNDABLE_BALANCE_SELECT,
      appointment: { select: { cancellationPolicy: POLICY_TERMS_INCLUDE } },
    },
  });
}

/** The class quote for a seat under way (D-4), from its ledger. */
export async function classSeatQuote(
  tx: Tx,
  ledger: SeatLedger,
  payment: NonNullable<Awaited<ReturnType<typeof seatPayment>>>,
  joinedAt: Date,
  now: Date,
): Promise<number> {
  const next = ledger.remaining[0];
  const quote = quoteClassSeatRefund({
    policy: termsFromPolicyRow(payment.appointment?.cancellationPolicy),
    isConsultantInitiated: false,
    unitPaise: ledger.unitPaise,
    remainingStartsMs: ledger.remaining.map((r) => r.startsAt.getTime()),
    neverScheduled: ledger.neverScheduled,
    movedStartsMs:
      next && movedAfter(next.movedAt, joinedAt)
        ? [next.startsAt.getTime()]
        : [],
    alreadyRefundedPaise: await occurrenceRefundsPaise(tx, payment.id),
    refundablePaise: refundableBalancePaise(Number(payment.amount), payment),
    nowMs: now.getTime(),
  });
  return quote.refundPaise;
}

/** The self-leave rule, inside the caller's transaction. Throws to refuse. */
export async function planSelfLeave(
  tx: Tx,
  kind: EventKind,
  eventId: string,
  userId: string,
  seat: Seat,
  now = new Date(),
): Promise<SeatRefundPlan> {
  const windowHours = eventRefundWindowHours(
    seat.refundWindowHours,
    await planWindowHours(tx, kind, eventId),
  );
  if (kind === "webinar") {
    const next = await findLiveEventSlot(
      { webinarId: eventId },
      { order: "asc", startsAtGte: now },
      tx,
    );
    assertOutsideWindow(next, seat.createdAt, windowHours, now);
    return { mode: "full" };
  }
  const payment = await seatPayment(tx, kind, eventId, userId);
  if (!payment) return { mode: "full" };
  // A re-bought seat reuses its row, so the later of the two is the purchase.
  const joinedAt = new Date(
    Math.max(payment.createdAt.getTime(), seat.createdAt.getTime()),
  );
  const ledger = await seatLedger(
    tx,
    { appointmentId: seat.appointmentId, createdAt: joinedAt },
    payment.amount,
    now,
  );
  const sessions = ledger.remaining.length + ledger.neverScheduled;
  if (ledger.deliveredHeld === 0) {
    assertOutsideWindow(ledger.remaining[0], joinedAt, windowHours, now);
    return { mode: "full", sessions };
  }
  return {
    amountPaise: await classSeatQuote(tx, ledger, payment, joinedAt, now),
    sessions,
  };
}

/**
 * #1780 E-5 — the exit right: with three host misses (or a quarter of the
 * series) the learner leaves with every undelivered session refunded, no
 * ladder, less any session already refunded on its own. Refused otherwise.
 */
async function planSeriesExit(
  tx: Tx,
  classId: string,
  userId: string,
  seat: Seat,
  now = new Date(),
): Promise<SeatRefundPlan> {
  const series = await seriesLedger(tx, seat.appointmentId, now);
  if (!series.exitRight) {
    throw new BookingRuleError(
      "EXIT_NOT_AVAILABLE",
      "This class has not missed enough sessions for a full-refund exit.",
    );
  }
  const payment = await seatPayment(tx, "class", classId, userId);
  if (!payment) return { mode: "full" };
  const joinedAt = new Date(
    Math.max(payment.createdAt.getTime(), seat.createdAt.getTime()),
  );
  const ledger = await seatLedger(
    tx,
    { appointmentId: seat.appointmentId, createdAt: joinedAt },
    payment.amount,
    now,
  );
  const quote = quoteClassSeatRefund({
    policy: termsFromPolicyRow(payment.appointment?.cancellationPolicy),
    isConsultantInitiated: true,
    unitPaise: ledger.unitPaise,
    remainingStartsMs: ledger.remaining.map((r) => r.startsAt.getTime()),
    neverScheduled: ledger.neverScheduled,
    alreadyRefundedPaise: await occurrenceRefundsPaise(tx, payment.id),
    refundablePaise: refundableBalancePaise(Number(payment.amount), payment),
    nowMs: now.getTime(),
  });
  return {
    amountPaise: quote.refundPaise,
    sessions: ledger.remaining.length + ledger.neverScheduled,
  };
}

export type SeatLeaveQuote =
  | { seated: false }
  | {
      seated: true;
      /** The window refuses this leave now (REFUND_WINDOW_CLOSED). */
      refused: boolean;
      message: string | null;
      estimatedRefundPaise: number;
      /** Class sessions the seat gives up; null for a webinar. */
      remainingSessions: number | null;
      currency: string;
    };

/**
 * #1780 D-4/D-6 — what leaving this seat right now pays back, for the preview
 * route and the class detail line. The same rule as the DELETE, read-only.
 */
export async function quoteSeatLeave(
  kind: EventKind,
  eventId: string,
  userId: string,
): Promise<SeatLeaveQuote> {
  return prisma.$transaction(async (tx) => {
    const seat = await tx.appointmentParticipant.findFirst({
      where: {
        appointment: eventFilter(kind, eventId),
        ...liveParticipant(userId),
      },
      select: {
        id: true,
        appointmentId: true,
        createdAt: true,
        refundWindowHours: true,
      },
    });
    if (!seat) return { seated: false } as const;
    const payment = await seatPayment(tx, kind, eventId, userId);
    const balance = payment
      ? refundableBalancePaise(Number(payment.amount), payment)
      : 0;
    const base = {
      seated: true as const,
      currency: payment?.currency ?? "INR",
      remainingSessions: null as number | null,
    };
    try {
      const plan = await planSelfLeave(tx, kind, eventId, userId, seat);
      return {
        ...base,
        refused: false,
        message: null,
        estimatedRefundPaise: "mode" in plan ? balance : plan.amountPaise,
        remainingSessions: plan.sessions ?? null,
      };
    } catch (error) {
      if (!(error instanceof BookingRuleError)) throw error;
      return {
        ...base,
        refused: true,
        message: error.message,
        estimatedRefundPaise: 0,
      };
    }
  });
}

/**
 * Release one seat under the rule, then refund it. Returns null when there was
 * no live seat to release (DELETE is idempotent). Throws BookingRuleError when
 * the rule refuses; the transaction has rolled back and the seat stays.
 */
export async function leaveEventSeat(args: {
  kind: EventKind;
  eventId: string;
  userId: string;
  actorUserId: string;
  isSelfLeave: boolean;
  /** The class exit right (E-5): a full refund of the undelivered sessions. */
  exit?: boolean;
}) {
  const filter = eventFilter(args.kind, args.eventId);
  const released = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const seat = await tx.appointmentParticipant.findFirst({
          where: { appointment: filter, ...liveParticipant(args.userId) },
          select: {
            id: true,
            appointmentId: true,
            createdAt: true,
            refundWindowHours: true,
          },
        });
        if (!seat) return null;
        let plan: SeatRefundPlan = { mode: "full" };
        if (args.exit) {
          plan = await planSeriesExit(tx, args.eventId, args.userId, seat);
        } else if (args.isSelfLeave) {
          plan = await planSelfLeave(
            tx,
            args.kind,
            args.eventId,
            args.userId,
            seat,
          );
        }
        // #1554 — the participant row IS the seat; the live-status CAS makes a
        // concurrent removal's loser match zero rows, so nothing refunds twice.
        const count = await releaseParticipant(tx, {
          appointment: filter,
          userId: args.userId,
        });
        return count > 0 ? { seat, plan } : null;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  if (!released) return null;

  const refund = await refundRemovedAttendeeSeat({
    kind: args.kind,
    eventId: args.eventId,
    attendeeUserId: args.userId,
    initiatedByUserId: args.actorUserId,
    initiatedBy: args.isSelfLeave ? "attendee" : "organiser",
    ...("mode" in released.plan
      ? { mode: released.plan.mode }
      : { amountPaise: released.plan.amountPaise }),
    dedupeKey: `${args.exit ? "seat-exit" : "seat-leave"}:${released.seat.id}`,
  });
  return { refund };
}
