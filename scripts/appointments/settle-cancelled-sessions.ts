/**
 * #1780 row 4 (E-4) — settle the class sessions a host cancelled 14 days ago.
 *
 * A host-cancelled session is made up (a live row with the same ordinal) or,
 * once 14 days pass without one, every seat that held it gets one unit back:
 * `refundBookingPayment` keyed `occ:<occurrence>:pay:<payment>`, the same key
 * the learner's own "skip the make-up" uses, so no seat is refunded twice.
 * State-as-outbox: the cohort is the unsettled row, `seatsSettledAt` is the
 * claim, and a gateway failure leaves the row unstamped so the next tick
 * retries only the seats whose key is still missing.
 *
 * Imported by jobs/appointments/settle-cancelled-sessions.ts (GitHub Actions)
 * and app/api/cleanup/settle-cancelled-sessions/route.ts (the ticker twin).
 */

import { OccurrenceCompletionStatus } from "@prisma/client";

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { seatLedger } from "@/lib/booking/class-series";
import {
  MAKEUP_WINDOW_DAYS,
  occurrenceRefundKey,
} from "@/lib/booking/class-sessions";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageTrigger } from "@/lib/novu/outbox";
import { reportSentryError } from "@/lib/observability/report";
import { formatCurrencyAmount } from "@/utils/formatting";

export interface SettleCancelledSessionsResult {
  success: boolean;
  scanned: number;
  stamped: number;
  refunded: number;
  errors: number;
  timestamp: string;
}

const DEFAULT_LIMIT = 10;
const DAY_MS = 86_400_000;
const LIVE_SIBLING: OccurrenceCompletionStatus[] = [
  "SCHEDULED",
  "COMPLETED",
  "UNVERIFIED",
];

type CancelledSession = {
  id: string;
  appointmentId: string;
  ordinal: number;
  startsAt: Date;
  appointment: { class: { classPlan: { title: string } } | null };
};

// #476 — one lock for every entry; fail-closed because this sweep refunds.
export async function settleCancelledSessions(
  opts: { limit?: number } = {},
): Promise<SettleCancelledSessionsResult> {
  return withCronLock("settle-cancelled-sessions", { failMode: "closed" }, () =>
    settleUnlocked(opts.limit ?? DEFAULT_LIMIT),
  );
}

async function settleUnlocked(
  limit: number,
): Promise<SettleCancelledSessionsResult> {
  const now = new Date();
  const result: SettleCancelledSessionsResult = {
    success: true,
    scanned: 0,
    stamped: 0,
    refunded: 0,
    errors: 0,
    timestamp: now.toISOString(),
  };
  const due = await prisma.appointmentOccurrence.findMany({
    where: {
      completionStatus: OccurrenceCompletionStatus.CANCELLED,
      hostCancelledAt: {
        lt: new Date(now.getTime() - MAKEUP_WINDOW_DAYS * DAY_MS),
      },
      seatsSettledAt: null,
      deletedAt: null,
      appointment: { classId: { not: null } },
    },
    orderBy: { hostCancelledAt: "asc" },
    take: limit,
    select: {
      id: true,
      appointmentId: true,
      ordinal: true,
      startsAt: true,
      appointment: {
        select: {
          class: { select: { classPlan: { select: { title: true } } } },
        },
      },
    },
  });
  result.scanned = due.length;

  for (const session of due) {
    try {
      const settled = await settleOne(session, result);
      if (settled) {
        const claimed = await prisma.appointmentOccurrence.updateMany({
          where: { id: session.id, seatsSettledAt: null },
          data: { seatsSettledAt: new Date() },
        });
        result.stamped += claimed.count;
      }
    } catch (error) {
      result.errors += 1;
      reportSentryError(error, {
        subsystem: "bookings",
        op: "settle-cancelled-sessions",
        extra: { occurrenceId: session.id },
      });
    }
  }
  result.success = result.errors === 0;
  return result;
}

/** True when the session is made up or every seat that held it is refunded. */
async function settleOne(
  session: CancelledSession,
  result: SettleCancelledSessionsResult,
): Promise<boolean> {
  const madeUp = await prisma.appointmentOccurrence.findFirst({
    where: {
      appointmentId: session.appointmentId,
      ordinal: session.ordinal,
      deletedAt: null,
      completionStatus: { in: LIVE_SIBLING },
    },
    select: { id: true },
  });
  if (madeUp) return true;

  const payments = await prisma.payment.findMany({
    where: {
      appointmentId: session.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      amount: { gt: 0 },
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      userId: true,
      createdAt: true,
    },
  });
  let pending = 0;
  for (const payment of payments) {
    const seat = await prisma.appointmentParticipant.findFirst({
      where: {
        appointmentId: session.appointmentId,
        userId: payment.userId,
        status: { in: ["CONFIRMED", "ATTENDED"] },
      },
      select: { createdAt: true },
    });
    const joinedAt =
      seat && seat.createdAt > payment.createdAt
        ? seat.createdAt
        : payment.createdAt;
    // Only a seat that held this session is owed for it.
    if (!seat || session.startsAt <= joinedAt) continue;
    const refunded = await refundSeatForSession(session, payment, joinedAt);
    if (refunded === null) pending += 1;
    else if (refunded) result.refunded += 1;
  }
  return pending === 0;
}

/** One seat's unit for one missed session; null when it must be retried. */
async function refundSeatForSession(
  session: CancelledSession,
  payment: { id: string; amount: number; currency: string; userId: string },
  joinedAt: Date,
): Promise<boolean | null> {
  const dedupeKey = occurrenceRefundKey(session.id, payment.id);
  // A seat that skipped the make-up (E-3b) or a prior tick already carries it.
  const spent = await prisma.refund.findUnique({
    where: { dedupeKey },
    select: { status: true },
  });
  if (spent && spent.status !== "FAILED" && spent.status !== "CANCELLED") {
    return false;
  }
  const ledger = await seatLedger(
    prisma,
    { appointmentId: session.appointmentId, createdAt: joinedAt },
    payment.amount,
  );
  // Never ask for more than the seat still has: an over-ask is refused and
  // would retry forever.
  const balance = await prisma.payment.findUnique({
    where: { id: payment.id },
    select: REFUNDABLE_BALANCE_SELECT,
  });
  const amountPaise = Math.min(
    Number(ledger.unitPaise),
    balance ? refundableBalancePaise(payment.amount, balance) : 0,
  );
  if (amountPaise <= 0) return false;
  try {
    const refund = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise,
      reason: "HOST_SESSION_NOT_MADE_UP",
      initiatedByUserId: null,
      dedupeKey,
      keepSeat: true,
    });
    // After the refund committed; the outbox relay delivers it (ADR 27).
    await stageTrigger({
      workflowId: NOVU_WORKFLOWS.CLASS_SESSION_REFUNDED,
      kind: "SINGLE",
      recipients: [payment.userId],
      payload: {
        planTitle: session.appointment.class?.classPlan.title ?? "your class",
        amount: formatCurrencyAmount(
          refund.amountRefundedPaise,
          payment.currency,
        ),
        dashboardUrl: "/dashboard",
      },
      dedupeKey,
    });
    return true;
  } catch (error) {
    // Nothing left to give back is settled; anything else retries next tick.
    const code = (error as { code?: string }).code;
    if (code === "ALREADY_FULLY_REFUNDED") return false;
    reportSentryError(error, {
      subsystem: "bookings",
      op: "settle-cancelled-sessions-refund",
      extra: { occurrenceId: session.id, paymentId: payment.id },
    });
    return null;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
