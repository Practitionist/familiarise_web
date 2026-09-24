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
import { seatLedger, type SeatLedger } from "./class-series";
import { liveParticipant, releaseParticipant } from "./participants";

export type EventKind = "class" | "webinar";

/** What the refund after the commit should do. */
export type SeatRefundPlan = { mode: "full" } | { amountPaise: number };

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
      createdAt: true,
      ...REFUNDABLE_BALANCE_SELECT,
      appointment: { select: { cancellationPolicy: POLICY_TERMS_INCLUDE } },
    },
  });
}

/** #1780 E-3b — units this payment already got back per session (`occ:*`). */
export async function occurrenceRefundsPaise(
  db: Pick<Tx, "refund">,
  paymentId: string,
): Promise<number> {
  const rows = await db.refund.findMany({
    where: {
      paymentId,
      status: { in: ["SUCCEEDED", "PENDING"] },
      dedupeKey: { startsWith: "occ:", endsWith: `:pay:${paymentId}` },
    },
    select: { amountPaise: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.amountPaise), 0);
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
  const joinedAt =
    payment.createdAt > seat.createdAt ? payment.createdAt : seat.createdAt;
  const ledger = await seatLedger(
    tx,
    { appointmentId: seat.appointmentId, createdAt: joinedAt },
    payment.amount,
    now,
  );
  if (ledger.deliveredHeld === 0) {
    assertOutsideWindow(ledger.remaining[0], joinedAt, windowHours, now);
    return { mode: "full" };
  }
  return {
    amountPaise: await classSeatQuote(tx, ledger, payment, joinedAt, now),
  };
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
  /** Overrides the self-leave rule (the class exit right, E-5). */
  plan?: (tx: Tx, seat: Seat) => Promise<SeatRefundPlan>;
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
        if (args.plan) plan = await args.plan(tx, seat);
        else if (args.isSelfLeave) {
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
    dedupeKey: `seat-leave:${released.seat.id}`,
  });
  return { refund };
}
