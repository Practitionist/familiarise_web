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
 * #1569 D4 — a VOIDED class, webinar or consultation session rides the same
 * machine (a webinar or consultation seat gets its full refundable balance),
 * and a VOIDED subscription session still unused when the plan ends is
 * refunded at the plan's per-session unit under `void-unused:` keys.
 *
 * Imported by jobs/appointments/settle-cancelled-sessions.ts (GitHub Actions)
 * and app/api/cleanup/settle-cancelled-sessions/route.ts (the ticker twin).
 */

import { OccurrenceCompletionStatus, Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { withAppointmentLock } from "@/utils/appointmentlock";
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
import {
  isCompletedOccurrence,
  sessionsTotalOf,
} from "@/lib/booking/entitlement";
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

type CancelledSession = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof DUE_SELECT;
}>;

/** #1569 D4 — the dedupe key of a subscription void refunded at plan end. */
export const voidUnusedRefundKey = (occurrenceId: string, paymentId: string) =>
  `void-unused:${occurrenceId}:pay:${paymentId}`;

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
    where: dueWhere(now),
    orderBy: { startsAt: "asc" },
    take: limit,
    select: DUE_SELECT,
  });
  result.scanned = due.length;

  for (const session of due) {
    try {
      await settleAndStamp(session, result);
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

/**
 * The cohort: a host-cancelled class session or a voided class, webinar or
 * consultation session whose make-up window is over, or a voided subscription
 * session whose plan has ended; not yet settled.
 */
function dueWhere(now: Date): Prisma.AppointmentOccurrenceWhereInput {
  const windowOver = new Date(now.getTime() - MAKEUP_WINDOW_DAYS * DAY_MS);
  return {
    seatsSettledAt: null,
    deletedAt: null,
    OR: [
      {
        completionStatus: OccurrenceCompletionStatus.CANCELLED,
        hostCancelledAt: { lt: windowOver },
        appointment: { classId: { not: null } },
      },
      {
        completionStatus: OccurrenceCompletionStatus.VOIDED,
        voidedAt: { lt: windowOver },
        appointment: {
          OR: [
            { classId: { not: null } },
            { webinarId: { not: null } },
            { consultationId: { not: null } },
          ],
        },
      },
      {
        completionStatus: OccurrenceCompletionStatus.VOIDED,
        voidedAt: { not: null },
        appointment: {
          subscription: { schedulingPeriodEndsAt: { lt: now } },
        },
      },
    ],
  };
}

const DUE_SELECT = {
  id: true,
  appointmentId: true,
  ordinal: true,
  startsAt: true,
  completionStatus: true,
  appointment: {
    select: {
      class: { select: { classPlan: { select: { title: true } } } },
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      consultation: {
        select: { consultationPlan: { select: { title: true } } },
      },
      subscription: {
        select: {
          status: true,
          sessionsTotal: true,
          subscriptionPlan: { select: { title: true, totalSessions: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

const planTitleOf = (s: CancelledSession) =>
  s.appointment.class?.classPlan.title ??
  s.appointment.webinar?.webinarPlan.title ??
  s.appointment.consultation?.consultationPlan.title ??
  s.appointment.subscription?.subscriptionPlan.title ??
  "your booking";

// Under the appointment lock: a make-up scheduled past day 14 (the ops
// bypass) and this refund cannot both win for one session (PR #1824).
async function settleAndStamp(
  session: CancelledSession,
  result: SettleCancelledSessionsResult,
): Promise<void> {
  await withAppointmentLock(session.appointmentId, async () => {
    if (!(await settleOne(session, result))) return;
    const claimed = await prisma.appointmentOccurrence.updateMany({
      where: { id: session.id, seatsSettledAt: null },
      data: { seatsSettledAt: new Date() },
    });
    result.stamped += claimed.count;
  });
}

/**
 * #1771 K-6 — the sweep for ONE session, from the ops console: the same
 * cohort predicate, the same keys and the same lock as the scheduled run, so
 * a session that is not due yet (or already settled) is scanned as zero.
 */
export async function settleCancelledSessionForOne(
  occurrenceId: string,
): Promise<SettleCancelledSessionsResult> {
  return withCronLock(
    "settle-cancelled-sessions",
    { failMode: "closed" },
    async () => {
      const now = new Date();
      const result: SettleCancelledSessionsResult = {
        success: true,
        scanned: 0,
        stamped: 0,
        refunded: 0,
        errors: 0,
        timestamp: now.toISOString(),
      };
      const session = await prisma.appointmentOccurrence.findFirst({
        where: { id: occurrenceId, ...dueWhere(now) },
        select: DUE_SELECT,
      });
      if (!session) return result;
      result.scanned = 1;
      await settleAndStamp(session, result);
      return result;
    },
  );
}

/** True when the session is made up or every seat that held it is refunded. */
async function settleOne(
  session: CancelledSession,
  result: SettleCancelledSessionsResult,
): Promise<boolean> {
  if (session.appointment.subscription) {
    return settleSubscriptionVoid(session, result);
  }
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

type SeatPayment = {
  id: string;
  amount: number;
  currency: string;
  userId: string;
};

/** A keyed refund that already moved (or is moving) money for this seat. */
async function alreadySpent(dedupeKey: string): Promise<boolean> {
  const spent = await prisma.refund.findUnique({
    where: { dedupeKey },
    select: { status: true },
  });
  return !!spent && spent.status !== "FAILED" && spent.status !== "CANCELLED";
}

/** Never ask for more than the seat still has: an over-ask retries forever. */
async function capToBalance(payment: SeatPayment, unitPaise: number) {
  const balance = await prisma.payment.findUnique({
    where: { id: payment.id },
    select: REFUNDABLE_BALANCE_SELECT,
  });
  const left = balance ? refundableBalancePaise(payment.amount, balance) : 0;
  return Math.min(unitPaise, left);
}

/** One seat's unit for one missed session; null when it must be retried. */
async function refundSeatForSession(
  session: CancelledSession,
  payment: SeatPayment,
  joinedAt: Date,
): Promise<boolean | null> {
  const dedupeKey = occurrenceRefundKey(session.id, payment.id);
  // A seat that skipped the make-up (E-3b) or a prior tick already carries it.
  if (await alreadySpent(dedupeKey)) return false;
  // #1569 D4 — a class seat gets one unit; a webinar or consultation is one session.
  const unitPaise = session.appointment.class
    ? Number(
        (
          await seatLedger(
            prisma,
            { appointmentId: session.appointmentId, createdAt: joinedAt },
            payment.amount,
          )
        ).unitPaise,
      )
    : payment.amount;
  const amountPaise = await capToBalance(payment, unitPaise);
  if (amountPaise <= 0) return false;
  const voided = session.completionStatus === OccurrenceCompletionStatus.VOIDED;
  return refundAndTell(session, payment, {
    amountPaise,
    dedupeKey,
    reason: voided ? "SESSION_VOIDED_NOT_MADE_UP" : "HOST_SESSION_NOT_MADE_UP",
  });
}

/**
 * #1569 D4 — a voided subscription session returned to the allowance; at plan
 * end, each one no later session made up is refunded at amount / sessions.
 */
async function settleSubscriptionVoid(
  session: CancelledSession,
  result: SettleCancelledSessionsResult,
): Promise<boolean> {
  const sub = session.appointment.subscription;
  // A cancelled or expired plan was refunded by its own path; nothing is owed here.
  if (!sub || !["APPROVED", "SCHEDULED", "COMPLETED"].includes(sub.status)) {
    return true;
  }
  const rows = await prisma.appointmentOccurrence.findMany({
    where: {
      appointmentId: session.appointmentId,
      isTentative: false,
      deletedAt: null,
    },
    select: {
      id: true,
      startsAt: true,
      completionStatus: true,
      seatsSettledAt: true,
    },
    orderBy: { startsAt: "asc" },
  });
  const total = sessionsTotalOf(sub);
  const delivered = rows.filter(isCompletedOccurrence).length;
  const unsettledVoids = rows.filter(
    (o) => o.completionStatus === "VOIDED" && !o.seatsSettledAt,
  );
  // Sessions still unused: the plan's size less what was delivered, and the
  // earliest voids are the ones the later sessions made up.
  const unused = Math.max(0, total - delivered);
  const madeUp = Math.max(0, unsettledVoids.length - unused);
  const position = unsettledVoids.findIndex((o) => o.id === session.id);
  if (position < madeUp) return true;

  const payments = await prisma.payment.findMany({
    where: {
      appointmentId: session.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      amount: { gt: 0 },
    },
    select: { id: true, amount: true, currency: true, userId: true },
  });
  let pending = 0;
  for (const payment of payments) {
    const dedupeKey = voidUnusedRefundKey(session.id, payment.id);
    if (await alreadySpent(dedupeKey)) continue;
    const amountPaise = await capToBalance(
      payment,
      Math.floor(payment.amount / Math.max(1, total)),
    );
    if (amountPaise <= 0) continue;
    const refunded = await refundAndTell(session, payment, {
      amountPaise,
      dedupeKey,
      reason: "SESSION_VOIDED_UNUSED_AT_PLAN_END",
    });
    if (refunded === null) pending += 1;
    else if (refunded) result.refunded += 1;
  }
  return pending === 0;
}

/** The keyed refund plus its bell; null when the gateway must be retried. */
async function refundAndTell(
  session: CancelledSession,
  payment: SeatPayment,
  args: { amountPaise: number; dedupeKey: string; reason: string },
): Promise<boolean | null> {
  try {
    const refund = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise: args.amountPaise,
      reason: args.reason,
      initiatedByUserId: null,
      dedupeKey: args.dedupeKey,
      keepSeat: true,
    });
    // After the refund committed; the outbox relay delivers it (ADR 27).
    await stageTrigger({
      workflowId: NOVU_WORKFLOWS.CLASS_SESSION_REFUNDED,
      kind: "SINGLE",
      recipients: [payment.userId],
      payload: {
        planTitle: planTitleOf(session),
        amount: formatCurrencyAmount(
          refund.amountRefundedPaise,
          payment.currency,
        ),
        dashboardUrl: "/dashboard",
      },
      dedupeKey: args.dedupeKey,
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
