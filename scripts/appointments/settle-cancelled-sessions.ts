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
 * machine (a webinar or consultation seat gets its full refundable balance).
 *
 * A subscription whose plan end has passed settles once: every session not
 * delivered (voided, returned or never placed) is refunded pro rata through a
 * durable `plan-end:` owed marker stamped in the commit that completes the plan.
 * A plan already COMPLETED with a void still unsettled settles it through the
 * same marker; only a cancelled, expired or rejected plan's void is stamped
 * without money, because its own refund path paid it.
 * The plan-end pass resumes each tick where the last one stopped, so plans
 * that must wait never starve the ones behind them.
 *
 * Imported by jobs/appointments/settle-cancelled-sessions.ts (GitHub Actions)
 * and app/api/cleanup/settle-cancelled-sessions/route.ts (the ticker twin).
 */

import { HOST_CANCELLED_SESSION_REASON } from "@/lib/booking/class-sessions";
import { refundNoticeText } from "@/lib/notifications/refund-wording";
import {
  CLASS_SESSION_REFUND_REASON,
  refundNoticeKind,
} from "@/lib/payments/operations/refund-cause";
import { HOST_ATTRIBUTED_OUTCOMES } from "@/lib/booking/session-outcome";
import { PLAN_END_REFUND_REASON } from "@/lib/payments/refund-reasons";
import {
  AppointmentStatus,
  OccurrenceCompletionStatus,
  Prisma,
} from "@prisma/client";

import { z } from "zod";

import prisma, { type Tx, type PrismaLike } from "../../lib/prisma";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { creditStillUsedPaise } from "@/lib/payments/operations/credit-plan-return";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { seatLedger } from "@/lib/booking/class-series";
import { seatJoinedAt, seatSessionClaim } from "@/lib/booking/seat-session";
import {
  MAKEUP_WINDOW_DAYS,
  occurrenceRefundKey,
} from "@/lib/booking/class-sessions";
import {
  isCompletedOccurrence,
  sessionsTotalOf,
  subscriptionIsOver,
} from "@/lib/booking/entitlement";
import { transitionSubscriptionRequest } from "@/lib/booking/transitions";
import { stampTranchesOnCancel } from "@/lib/booking/subscription-cycle";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  driveRefundOwed,
  stampRefundOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { AWAITING_HUMAN } from "@/lib/booking/misses";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { notificationHref } from "@/lib/novu/resolve-href";
import { startDeadline } from "@/lib/cron/run-deadline";
import { subMonths } from "date-fns";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import { goHref } from "@/lib/dashboard/go";
import { reportSentryError } from "@/lib/observability/report";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { isFreeCreditIntent } from "@/lib/payments/funding-rail";
import { formatNotificationMoney } from "@/lib/novu/humanize";

export interface SettleCancelledSessionsResult {
  success: boolean;
  scanned: number;
  /** Plans past their end read by the plan-end pass. */
  plansScanned: number;
  /** Plans past their end that could not settle yet and are revisited. */
  plansWaiting: number;
  stamped: number;
  refunded: number;
  errors: number;
  /** The run hit its start deadline with due sessions or plans left. */
  hasMore: boolean;
  timestamp: string;
  /** Where the plan-end pass resumes next run; null starts both cohorts over. */
  checkpoint: string | null;
}

const JOB_NAME = "settle-cancelled-sessions";

// Per-seat refund failures collapse to one event per run.
const runFailures = createRunFailureReporter("bookings");
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

/** The plan-end refund of a subscription's undelivered sessions, one per payment. */
export const planEndRefundKey = (subscriptionId: string, paymentId: string) =>
  `plan-end:${subscriptionId}:pay:${paymentId}`;
const PLAN_ENDED_HISTORY_REASON = "PLAN_ENDED";
const PLAN_LIVE_STATUSES: AppointmentStatus[] = [AppointmentStatus.APPROVED];

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
    plansScanned: 0,
    plansWaiting: 0,
    stamped: 0,
    refunded: 0,
    errors: 0,
    hasMore: false,
    timestamp: now.toISOString(),
    checkpoint: await readJobCheckpoint(JOB_NAME),
  };
  // One deadline for the whole run: a slow gateway cuts it between rows.
  const outOfTime = startDeadline();
  const due = await prisma.appointmentOccurrence.findMany({
    where: dueWhere(now),
    orderBy: { startsAt: "asc" },
    take: limit,
    select: DUE_SELECT,
  });
  result.scanned = due.length;

  // One Sentry event per run, never per row: a systemic fault fails
  // every row and used to cost one event each.
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const session of due) {
    if (outOfTime()) {
      result.hasMore = true;
      break;
    }
    try {
      await settleAndStamp(session, result);
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(session.id);
      // Console bypasses the Sentry scrubber, so log a scrubbed message only.
      console.error(
        `settle-cancelled-sessions: occurrence ${session.id} failed:`,
        scrubStringValue(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "bookings",
      op: "settle-cancelled-sessions",
      fingerprint: ["settle-cancelled-sessions"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
  result.stamped += await settleVoidsOfEndedPlans(now);
  if (!outOfTime()) await settleVoidsOfCompletedPlans(now, limit, result);
  await settleEndedPlans(now, limit, result, outOfTime);
  runFailures.flush();
  result.success = result.errors === 0;
  return result;
}

/**
 * The cohort: a host-cancelled class session or a voided class, webinar or
 * consultation session whose make-up window is over; not yet settled.
 * Subscription voids settle with their plan instead.
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
    ],
  };
}

const DUE_SELECT = {
  id: true,
  appointmentId: true,
  ordinal: true,
  startsAt: true,
  completionStatus: true,
  outcome: true,
  appointment: {
    select: {
      class: {
        select: { status: true, classPlan: { select: { title: true } } },
      },
      webinar: {
        select: { status: true, webinarPlan: { select: { title: true } } },
      },
      consultation: {
        select: {
          status: true,
          consultationPlan: { select: { title: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

const planTitleOf = (s: CancelledSession) =>
  s.appointment.class?.classPlan.title ??
  s.appointment.webinar?.webinarPlan.title ??
  s.appointment.consultation?.consultationPlan.title ??
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
      // This run reads no plans, so it hands the scheduled run's cursor on.
      const result: SettleCancelledSessionsResult = {
        success: true,
        scanned: 0,
        plansScanned: 0,
        plansWaiting: 0,
        stamped: 0,
        refunded: 0,
        errors: 0,
        hasMore: false,
        timestamp: now.toISOString(),
        checkpoint: await readJobCheckpoint(JOB_NAME),
      };
      const session = await prisma.appointmentOccurrence.findFirst({
        where: { id: occurrenceId, ...dueWhere(now) },
        select: DUE_SELECT,
      });
      if (!session) return result;
      result.scanned = 1;
      try {
        await settleAndStamp(session, result);
      } finally {
        runFailures.flush();
      }
      return result;
    },
  );
}

/** True when the session is made up or every seat that held it is refunded. */
async function settleOne(
  session: CancelledSession,
  result: SettleCancelledSessionsResult,
): Promise<boolean> {
  // #1569 — a cancelled parent refunded every undelivered session, this one
  // included (seriesCancelRefundPaise); refunding it again would over-pay.
  const { class: cls, webinar, consultation } = session.appointment;
  if ((cls ?? webinar ?? consultation)?.status === "CANCELLED") return true;
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
    const outcome = await settleSeat(session, payment);
    if (outcome === null) pending += 1;
    else if (outcome) result.refunded += 1;
  }
  return pending === 0;
}

type SeatPayment = {
  id: string;
  amount: number;
  currency: string;
  userId: string;
};

/**
 * One payment's share of a missed session: true refunded, false nothing owed
 * or sent to ops, null to retry on the next run.
 */
async function settleSeat(
  session: CancelledSession,
  payment: SeatPayment & { createdAt: Date },
): Promise<boolean | null> {
  const seat = await prisma.appointmentParticipant.findFirst({
    where: {
      appointmentId: session.appointmentId,
      userId: payment.userId,
      status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
      // #1834 — a seat funded by another order (a re-bought seat reuses its
      // row) is not this payment's; a legacy seat with no link keeps the match.
      OR: [{ paymentId: payment.id }, { paymentId: null }],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      sessionsPurchased: true,
    },
  });
  if (!seat) return false;
  const claim = seatSessionClaim(session, seat, payment);
  if (claim === "none") return false;
  const joinedAt = seatJoinedAt(seat, payment);
  if (claim === "human") {
    // #1834 owner decision — a paid seat still HELD is a human's call, never
    // skipped silently nor auto-refunded; the session settles for the rest.
    await escalateHeldPaidSeat(session, payment, seat.id, {
      unitPaise: await seatUnitPaise(
        session,
        payment,
        joinedAt,
        seat.sessionsPurchased,
      ),
    });
    return false;
  }
  return refundSeatForSession(
    session,
    payment,
    joinedAt,
    seat.sessionsPurchased,
  );
}

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

/** #1569 D4 — a class seat gets one unit; a webinar or consultation is one session. */
async function seatUnitPaise(
  session: CancelledSession,
  payment: SeatPayment,
  joinedAt: Date,
  sessionsPurchased: number | null,
): Promise<number> {
  return session.appointment.class
    ? Number(
        (
          await seatLedger(
            prisma,
            {
              appointmentId: session.appointmentId,
              createdAt: joinedAt,
              sessionsPurchased,
            },
            payment.amount,
          )
        ).unitPaise,
      )
    : payment.amount;
}

/** #1834 — one needs-human row per held paid seat and session, deduped by key. */
async function escalateHeldPaidSeat(
  session: CancelledSession,
  payment: SeatPayment,
  participantId: string,
  extra: { unitPaise: number },
): Promise<void> {
  const correlationId = `held-paid-seat:${session.id}:${payment.id}`;
  const seen = await prisma.systemEvent.findFirst({
    where: { correlationId },
    select: { id: true },
  });
  if (seen) return;
  await recordSystemEvent({
    category: "BOOKING",
    severity: "WARN",
    message: `Paid seat still held for a missed session; payment ${payment.id} needs a human refund decision`,
    context: {
      occurrenceId: session.id,
      paymentId: payment.id,
      participantId,
      unitPaise: extra.unitPaise,
    },
    correlationId,
    // A lost row would settle the session with nobody told; fail and retry.
    strict: true,
  });
}

/** One seat's unit for one missed session; null when it must be retried. */
async function refundSeatForSession(
  session: CancelledSession,
  payment: SeatPayment,
  joinedAt: Date,
  sessionsPurchased: number | null,
): Promise<boolean | null> {
  const dedupeKey = occurrenceRefundKey(session.id, payment.id);
  // A seat that skipped the make-up (E-3b) or a prior tick already carries it.
  if (await alreadySpent(dedupeKey)) return false;
  const unitPaise = await seatUnitPaise(
    session,
    payment,
    joinedAt,
    sessionsPurchased,
  );
  const amountPaise = await capToBalance(payment, unitPaise);
  if (amountPaise <= 0) return false;
  const voided = session.completionStatus === OccurrenceCompletionStatus.VOIDED;
  const hostVoid =
    voided &&
    session.outcome !== null &&
    HOST_ATTRIBUTED_OUTCOMES.includes(session.outcome);
  // A seat holder who cancelled the session themself is refunded under a reason that stays optional.
  const ownCancel =
    !voided && (await sessionCancelledBy(session.id)) === payment.userId;
  return refundAndTell(session, payment, {
    amountPaise,
    dedupeKey,
    reason: ownCancel
      ? CLASS_SESSION_REFUND_REASON.OWN_CANCEL
      : !voided
        ? CLASS_SESSION_REFUND_REASON.HOST_CANCELLED
        : hostVoid
          ? CLASS_SESSION_REFUND_REASON.HOST_VOIDED
          : CLASS_SESSION_REFUND_REASON.VOIDED,
  });
}

/** Who cancelled the session, from its cancel's history row; null for a void or an unattributed cancel. */
async function sessionCancelledBy(
  occurrenceId: string,
): Promise<string | null> {
  const row = await prisma.bookingStatusHistory.findFirst({
    where: {
      entity: "OCCURRENCE",
      entityId: occurrenceId,
      reason: HOST_CANCELLED_SESSION_REASON,
    },
    orderBy: { createdAt: "desc" },
    select: { actorUserId: true },
  });
  return row?.actorUserId ?? null;
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
    const formattedAmount = formatNotificationMoney(
      refund.amountRefundedPaise,
      payment.currency,
    );
    const dashboardUrl = goHref("client", "appointments");
    // A refund still settling at the gateway has started; only a settled one is on its way.
    const pending = refund.status === "PENDING";
    // A refund the host caused reaches the seat whatever their switches say.
    const hostCaused = refundNoticeKind(args.reason) !== null;
    const [staged, emailRows] = await Promise.all([
      stageBell(prisma, {
        workflowId: NOVU_WORKFLOWS.CLASS_SESSION_REFUNDED,
        recipients: [payment.userId],
        payload: {
          planTitle: planTitleOf(session),
          amount: formattedAmount,
          // The seat holder is always a consultee.
          dashboardUrl,
          ...(pending ? { refundStarted: true } : {}),
        },
        dedupeKey: args.dedupeKey,
        ...(hostCaused ? { required: "CLASS_SESSION_REFUNDED" as const } : {}),
      }),
      stageAppointmentCancelledEmail(prisma, {
        appointmentId: session.appointmentId,
        userIds: [payment.userId],
        startsAt: session.startsAt,
        cancelledBy: "Familiarise",
        reason: args.reason,
        refundText: refundNoticeText(
          refund.amountRefundedPaise,
          payment.currency,
          pending,
        ),
        refundUserIds: [payment.userId],
        ...(hostCaused ? { requiredFor: [payment.userId] } : {}),
        dashboardUrl,
      }).catch((err) => {
        console.error(
          "[settle-cancelled-sessions] Failed to stage APPOINTMENT_CANCELLED email:",
          err,
        );
        return [];
      }),
    ]);
    await flushNotificationsAfter(
      {
        bells: [staged],
        emails: [{ rows: emailRows, emailType: "APPOINTMENT_CANCELLED" }],
      },
      "settle-cancelled-sessions.refund",
    );
    return true;
  } catch (error) {
    // Nothing left to give back is settled; anything else retries next tick.
    const code = (error as { code?: string }).code;
    if (code === "ALREADY_FULLY_REFUNDED") return false;
    runFailures.add("settle-cancelled-sessions-refund", error, {
      occurrenceId: session.id,
      paymentId: payment.id,
    });
    return null;
  }
}

const PLAN_END_SELECT = {
  id: true,
  planEndsAt: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  subscriptionPlan: { select: { durationInMonths: true } },
  appointment: { select: { id: true } },
} satisfies Prisma.SubscriptionSelect;

type EndedPlan = Prisma.SubscriptionGetPayload<{
  select: typeof PLAN_END_SELECT;
}>;

/** What the settling commit re-reads under the lock; the cohort row is advisory. */
const PLAN_SETTLE_SELECT = {
  status: true,
  sessionsTotal: true,
  planEndsAt: true,
  schedulingPeriodStartsAt: true,
  schedulingTimezone: true,
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
  subscriptionPlan: {
    select: {
      title: true,
      totalSessions: true,
      durationInMonths: true,
      consultantProfile: {
        select: { user: { select: { id: true, name: true } } },
      },
    },
  },
  appointment: { select: { organizationId: true } },
} satisfies Prisma.SubscriptionSelect;

/** Statuses whose own refund path already paid a void back. */
const PLAN_REFUNDED_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.EXPIRED,
  AppointmentStatus.REJECTED,
];

/**
 * A void on a cancelled, expired or rejected plan is settled without money:
 * that plan's cancel or expiry quote already paid it back. The stamp keeps it
 * from holding the plan's earnings.
 */
async function settleVoidsOfEndedPlans(now: Date): Promise<number> {
  const { count } = await prisma.appointmentOccurrence.updateMany({
    where: voidOfRefundedPlanWhere(),
    data: { seatsSettledAt: now },
  });
  return count;
}

/**
 * A COMPLETED plan still holding an unsettled void was completed before plan
 * end could pay it: each settles once, refunding the undelivered share the
 * voids account for through the plan-end owed marker, then stamps them.
 */
async function settleVoidsOfCompletedPlans(
  now: Date,
  limit: number,
  result: SettleCancelledSessionsResult,
): Promise<void> {
  const plans = await prisma.subscription.findMany({
    where: completedPlanWithVoidWhere(),
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true, appointment: { select: { id: true } } },
  });
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const plan of plans) {
    const appointmentId = plan.appointment?.id;
    if (!appointmentId) continue;
    try {
      await settleCompletedPlanVoids(plan.id, appointmentId, now, result);
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(plan.id);
      console.error(
        `settle-cancelled-sessions: completed plan ${plan.id} failed:`,
        scrubStringValue(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "bookings",
      op: "settle-cancelled-sessions.completed-plan-voids",
      fingerprint: ["settle-cancelled-sessions", "completed-plan-voids"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
}

async function settleCompletedPlanVoids(
  planId: string,
  appointmentId: string,
  now: Date,
  result: SettleCancelledSessionsResult,
): Promise<void> {
  await withAppointmentLock(appointmentId, async () => {
    let committed: { markers: RefundOwedMarker[]; stamped: number };
    try {
      committed = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const sub = await tx.subscription.findUnique({
              where: { id: planId },
              select: {
                status: true,
                sessionsTotal: true,
                subscriptionPlan: { select: { totalSessions: true } },
              },
            });
            if (sub?.status !== AppointmentStatus.COMPLETED) {
              throw new PlanWaiting();
            }
            const rows = await tx.appointmentOccurrence.findMany({
              where: { appointmentId, isTentative: false, deletedAt: null },
              select: { completionStatus: true, seatsSettledAt: true },
            });
            const voids = rows.filter(
              (row) =>
                row.completionStatus === OccurrenceCompletionStatus.VOIDED &&
                row.seatsSettledAt === null,
            ).length;
            if (voids === 0) throw new PlanWaiting();
            const total = sessionsTotalOf(sub);
            const delivered = rows.filter(isCompletedOccurrence).length;
            // A void a delivered replacement already covered is owed nothing.
            const unused = Math.min(Math.max(0, total - delivered), voids);

            const { count: stamped } =
              await tx.appointmentOccurrence.updateMany({
                where: { appointmentId, ...UNSETTLED_VOID },
                data: { seatsSettledAt: now },
              });
            const markers = await settlePlanPayments(tx, {
              planId,
              appointmentId,
              unused,
              total,
              now,
            });
            return { markers, stamped };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      if (error instanceof PlanWaiting || error instanceof PlanEndMarkerHeld) {
        return;
      }
      throw error;
    }
    result.stamped += committed.stamped;
    await driveMarkers(committed.markers, planId, result);
  });
}

/** An unsettled void on a live row. */
const UNSETTLED_VOID = {
  completionStatus: OccurrenceCompletionStatus.VOIDED,
  seatsSettledAt: null,
  deletedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

// The run's cohort predicates, shared with the ticker's idle probe.
function voidOfRefundedPlanWhere() {
  return {
    completionStatus: OccurrenceCompletionStatus.VOIDED,
    seatsSettledAt: null,
    deletedAt: null,
    appointment: {
      subscription: { status: { in: PLAN_REFUNDED_STATUSES } },
    },
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
}

function completedPlanWithVoidWhere() {
  return {
    status: AppointmentStatus.COMPLETED,
    appointment: { occurrences: { some: UNSETTLED_VOID } },
  } satisfies Prisma.SubscriptionWhereInput;
}

const LIVE_PLAN = {
  deletedAt: null,
  status: { in: PLAN_LIVE_STATUSES },
  appointment: { isNot: null },
} satisfies Prisma.SubscriptionWhereInput;

function storedEndPlanWhere(now: Date) {
  return {
    ...LIVE_PLAN,
    planEndsAt: { lte: now },
  } satisfies Prisma.SubscriptionWhereInput;
}

/** Prefiltered by start; the run checks the derived end per plan. */
function derivedEndPlanWhere(now: Date) {
  return {
    ...LIVE_PLAN,
    planEndsAt: null,
    schedulingPeriodStartsAt: { lt: subMonths(now, 1) },
  } satisfies Prisma.SubscriptionWhereInput;
}

export async function hasSettleCancelledSessionsWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const session = await db.appointmentOccurrence.findFirst({
    where: { OR: [dueWhere(now), voidOfRefundedPlanWhere()] },
    select: { id: true },
  });
  if (session) return true;
  if (outOfTime()) return true;
  const plan = await db.subscription.findFirst({
    where: {
      OR: [
        completedPlanWithVoidWhere(),
        storedEndPlanWhere(now),
        derivedEndPlanWhere(now),
      ],
    },
    select: { id: true },
  });
  return plan !== null;
}

/** A payment already owes another door's refund; the plan waits behind it. */
class PlanEndMarkerHeld extends Error {
  constructor(paymentId: string) {
    super(`payment ${paymentId} already owes another refund`);
    this.name = "PlanEndMarkerHeld";
  }
}

const PLAN_PAGES_PER_RUN = 5;

/** A cohort's resume point: the order key and id of the last plan it handled. */
const planKeySchema = z.object({ at: z.coerce.date(), id: z.string() });
const planCursorSchema = z.object({
  stored: planKeySchema.nullable(),
  derived: planKeySchema.nullable(),
});
type PlanKey = z.infer<typeof planKeySchema>;
type PlanCursor = z.infer<typeof planCursorSchema>;

/** An unreadable checkpoint starts both cohorts over; settling is idempotent. */
export function parsePlanCursor(checkpoint: string | null): PlanCursor {
  const start = { stored: null, derived: null };
  if (!checkpoint) return start;
  try {
    const parsed = planCursorSchema.safeParse(JSON.parse(checkpoint));
    return parsed.success ? parsed.data : start;
  } catch {
    return start;
  }
}

/** Rows strictly after `key` in (`field`, id) order. */
function afterKey(
  field: "planEndsAt" | "schedulingPeriodStartsAt",
  key: PlanKey | null,
): Prisma.SubscriptionWhereInput {
  if (!key) return {};
  const tie = { id: { gt: key.id } };
  return field === "planEndsAt"
    ? {
        OR: [{ planEndsAt: { gt: key.at } }, { planEndsAt: key.at, ...tie }],
      }
    : {
        OR: [
          { schedulingPeriodStartsAt: { gt: key.at } },
          { schedulingPeriodStartsAt: key.at, ...tie },
        ],
      };
}

/**
 * Live plans whose fixed end has passed, in two keyset cohorts: a stored end,
 * and no stored end (pre-reset), prefiltered by start with the derived end
 * checked here; nothing is written back to the row. Each cohort resumes after
 * the last plan the previous run handled and starts over once it reaches the
 * end, so every plan is reached however many ahead of it must wait.
 */
async function settleEndedPlans(
  now: Date,
  limit: number,
  result: SettleCancelledSessionsResult,
  outOfTime: () => boolean,
): Promise<void> {
  const failedIds: string[] = [];
  let firstError: unknown;
  const cursor = parsePlanCursor(result.checkpoint);

  /** Settles the plans in order; false when the deadline cut the page short. */
  const settlePage = async (
    plans: EndedPlan[],
    handled: (plan: EndedPlan) => void,
  ): Promise<boolean> => {
    for (const plan of plans) {
      if (outOfTime()) return false;
      result.plansScanned += 1;
      if (subscriptionIsOver(plan, now)) {
        try {
          if (!(await settleEndedPlan(plan, now, result))) {
            result.plansWaiting += 1;
          }
        } catch (error) {
          result.errors += 1;
          firstError ??= error;
          failedIds.push(plan.id);
          console.error(
            `settle-cancelled-sessions: plan ${plan.id} failed:`,
            scrubStringValue(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
      handled(plan);
    }
    return true;
  };

  /** One cohort's pass; returns where the next run resumes it. */
  const scanCohort = async (
    from: PlanKey | null,
    read: (after: PlanKey | null) => Promise<EndedPlan[]>,
    keyOf: (plan: EndedPlan) => PlanKey,
  ): Promise<PlanKey | null> => {
    let after = from;
    for (let page = 0; page < PLAN_PAGES_PER_RUN; page++) {
      if (outOfTime()) {
        result.hasMore = true;
        return after;
      }
      const plans = await read(after);
      // Nothing left past the cursor: start the cohort over in this run.
      if (plans.length === 0 && after && page === 0) {
        after = null;
        continue;
      }
      const whole = await settlePage(plans, (plan) => {
        after = keyOf(plan);
      });
      if (!whole) {
        result.hasMore = true;
        return after;
      }
      if (plans.length < limit) return null;
    }
    return after;
  };

  const stored = await scanCohort(
    cursor.stored,
    (after) =>
      prisma.subscription.findMany({
        where: {
          ...storedEndPlanWhere(now),
          ...afterKey("planEndsAt", after),
        },
        orderBy: [{ planEndsAt: "asc" }, { id: "asc" }],
        take: limit,
        select: PLAN_END_SELECT,
      }),
    // The cohort's WHERE guarantees a stored end.
    (plan) => ({ at: plan.planEndsAt ?? now, id: plan.id }),
  );
  const derived = await scanCohort(
    cursor.derived,
    (after) =>
      prisma.subscription.findMany({
        where: {
          ...derivedEndPlanWhere(now),
          ...afterKey("schedulingPeriodStartsAt", after),
        },
        orderBy: [{ schedulingPeriodStartsAt: "asc" }, { id: "asc" }],
        take: limit,
        select: PLAN_END_SELECT,
      }),
    (plan) => ({ at: plan.schedulingPeriodStartsAt, id: plan.id }),
  );
  result.checkpoint =
    stored || derived ? JSON.stringify({ stored, derived }) : null;

  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "bookings",
      op: "settle-cancelled-sessions.plan-end",
      fingerprint: ["settle-cancelled-sessions", "plan-end"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
}

/**
 * Settles ONE ended plan under its appointment lock. One commit re-reads the
 * plan, completes it by CAS on the status and end it read, marks its voids
 * settled, stamps the earnings holds, the pro-rata owed refund and both
 * parties' bell; the refund is driven after. False when the plan must wait.
 */
async function settleEndedPlan(
  plan: EndedPlan,
  now: Date,
  result: SettleCancelledSessionsResult,
): Promise<boolean> {
  const appointmentId = plan.appointment?.id;
  if (!appointmentId) return false;
  return withAppointmentLock(appointmentId, async () => {
    let committed: { markers: RefundOwedMarker[]; bell: StagedTrigger | null };
    try {
      committed = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const sub = await tx.subscription.findUnique({
              where: { id: plan.id },
              select: PLAN_SETTLE_SELECT,
            });
            if (
              !sub ||
              !PLAN_LIVE_STATUSES.includes(sub.status) ||
              !subscriptionIsOver(sub, now)
            ) {
              throw new PlanWaiting();
            }
            // A session still SCHEDULED or parked for ops could yet count as
            // delivered, and an open reschedule could still place one.
            const undecided = await tx.appointmentOccurrence.count({
              where: {
                appointmentId,
                isTentative: false,
                OR: [
                  {
                    completionStatus: OccurrenceCompletionStatus.SCHEDULED,
                    deletedAt: null,
                  },
                  AWAITING_HUMAN,
                ],
              },
            });
            if (undecided > 0) throw new PlanWaiting();
            const openReschedule = await tx.rescheduleRequest.findFirst({
              where: { openForAppointmentId: appointmentId },
              select: { id: true },
            });
            if (openReschedule) throw new PlanWaiting();
            // An approved session-count remedy whose refund is not live yet
            // would be paid again by this share; ops retries or voids it first.
            const unsentRemedy =
              await tx.supportFinancialRecommendation.findFirst({
                where: {
                  payment: { appointmentId },
                  approved: true,
                  voidedAt: null,
                  sessionsRemoved: { not: null },
                  OR: [
                    { refundId: null },
                    { refund: { status: { in: ["FAILED", "CANCELLED"] } } },
                  ],
                },
                select: { id: true },
              });
            if (unsentRemedy) throw new PlanWaiting();

            const rows = await tx.appointmentOccurrence.findMany({
              where: { appointmentId, isTentative: false, deletedAt: null },
              select: { completionStatus: true },
            });
            const total = sessionsTotalOf(sub);
            const delivered = rows.filter(isCompletedOccurrence).length;
            const unused = total > 0 ? Math.max(0, total - delivered) : 0;

            await transitionSubscriptionRequest(tx, {
              where: { id: plan.id, planEndsAt: sub.planEndsAt },
              to: AppointmentStatus.COMPLETED,
              fromIn: [sub.status],
              reason: PLAN_ENDED_HISTORY_REASON,
            });
            await tx.appointmentOccurrence.updateMany({
              where: {
                appointmentId,
                completionStatus: OccurrenceCompletionStatus.VOIDED,
                seatsSettledAt: null,
                deletedAt: null,
              },
              data: { seatsSettledAt: now },
            });

            const markers = await settlePlanPayments(tx, {
              planId: plan.id,
              appointmentId,
              unused,
              total,
              now,
            });
            const bell = await stagePlanEndedBell(tx, plan.id, sub);
            return { markers, bell };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      // Another writer moved the plan, or it must wait; neither is a fault.
      if (
        error instanceof PlanWaiting ||
        error instanceof PlanEndMarkerHeld ||
        error instanceof IllegalTransitionError
      ) {
        return false;
      }
      throw error;
    }
    await flushNotificationsAfter(
      { bells: [committed.bell] },
      "settle-cancelled-sessions.plan-end",
    );
    await driveMarkers(committed.markers, plan.id, result);
    return true;
  });
}

/**
 * On the settling commit: what each SUCCEEDED payment of the plan owes for
 * `unused` of `total` sessions, stamped as its owed marker, with its earnings
 * holds stamped. A credit seat that delivered some sessions goes to a human.
 * Throws `PlanEndMarkerHeld` when another door's marker owns a payment, so the
 * whole commit waits.
 */
async function settlePlanPayments(
  tx: Tx,
  args: {
    planId: string;
    appointmentId: string;
    unused: number;
    total: number;
    now: Date;
  },
): Promise<RefundOwedMarker[]> {
  // A wholly credit-funded plan (amount 0) settles too: its value is the
  // referral credit the buyer spent.
  const payments = await tx.payment.findMany({
    where: {
      appointmentId: args.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const markers: RefundOwedMarker[] = [];
  for (const payment of payments) {
    const settlement = planEndSettlement(
      args.planId,
      payment,
      args.unused,
      args.total,
    );
    // A plan with no referral credit still consumed (a 100% discount, or
    // credit already returned) has nothing for a human to return.
    const review =
      settlement?.review === true &&
      (await creditStillUsedPaise(tx, payment.id)) > 0;
    if (review) {
      // The credits rail restores whole or not at all, so a plan that
      // delivered some sessions returns the rest by hand; its tranches stay
      // unheld until ops returns the credit or closes the return, either of
      // which stamps them.
      await recordSystemEvent({
        db: tx,
        strict: true,
        category: "BOOKING",
        severity: "WARN",
        message: `Credit seat ${payment.id} needs a partial credit return`,
        context: {
          paymentId: payment.id,
          subscriptionId: args.planId,
          sessionsTotal: args.total,
          sessionsUnused: args.unused,
        },
        correlationId: `partial-credit:${payment.id}`,
      });
      continue;
    }
    await stampTranchesOnCancel(tx, { paymentId: payment.id, now: args.now });
    const marker = settlement && !settlement.review ? settlement.marker : null;
    if (!marker) continue;
    if (!(await stampRefundOwed(tx, marker))) {
      throw new PlanEndMarkerHeld(payment.id);
    }
    markers.push(marker);
  }
  return markers;
}

/** Drives each committed marker; a failure stays for the retry sweep. */
async function driveMarkers(
  markers: RefundOwedMarker[],
  subscriptionId: string,
  result: SettleCancelledSessionsResult,
): Promise<void> {
  for (const marker of markers) {
    const outcome = await driveRefundOwed(marker);
    if (outcome.kind === "refunded" || outcome.kind === "replayed") {
      result.refunded += 1;
    } else if (outcome.kind === "failed") {
      // The marker stays; the retry-auto-refunds sweep re-drives it.
      runFailures.add("settle-cancelled-sessions-plan-end", outcome.error, {
        subscriptionId,
        paymentId: marker.paymentId,
      });
    }
  }
}

/** Both parties hear that the plan ended, once per plan. */
async function stagePlanEndedBell(
  tx: Parameters<typeof stageBell>[0],
  subscriptionId: string,
  sub: Prisma.SubscriptionGetPayload<{ select: typeof PLAN_SETTLE_SELECT }>,
): Promise<StagedTrigger | null> {
  const expert = sub.subscriptionPlan.consultantProfile.user;
  const learner = sub.requestedBy.user;
  const organizationId = sub.appointment?.organizationId ?? null;
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.APPOINTMENT_COMPLETED,
    recipients: [learner.id, expert.id],
    payload: {
      ...notificationScope(organizationId),
      appointmentType: "subscription",
      consultantName: expert.name ?? "Consultant",
      consulteeName: learner.name ?? "Client",
      planTitle: sub.subscriptionPlan.title,
      dashboardUrl: notificationHref(organizationId, "appointments"),
    },
    dedupeKey: `plan-end:${subscriptionId}`,
  });
}

class PlanWaiting extends Error {
  constructor() {
    super("plan has an undecided session");
    this.name = "PlanWaiting";
  }
}

/**
 * What an ended plan owes one payment. A wholly credit-funded payment restores
 * its credit in full (no amount: the credits rail's only shape) when nothing
 * was delivered, and goes to a human when some was; money is pro-rata.
 */
export function planEndSettlement(
  subscriptionId: string,
  payment: Parameters<typeof planEndMarker>[1] & { paymentIntent: string },
  unused: number,
  total: number,
): { marker: RefundOwedMarker; review?: never } | { review: true } | null {
  if (unused <= 0 || total <= 0) return null;
  if (payment.amount === 0 && isFreeCreditIntent(payment.paymentIntent)) {
    if (unused < total) return { review: true };
    return {
      marker: {
        paymentId: payment.id,
        amountPaise: null,
        key: planEndRefundKey(subscriptionId, payment.id),
        reason: PLAN_END_REFUND_REASON,
      },
    };
  }
  const marker = planEndMarker(subscriptionId, payment, unused, total);
  return marker ? { marker } : null;
}

/**
 * The pro-rata share of the undelivered sessions, less whatever this payment
 * already returned (an incident or goodwill refund paid some of them back).
 */
export function planEndMarker(
  subscriptionId: string,
  payment: {
    id: string;
    amount: number;
    refunds: { amountPaise: number; status: string }[];
    disputes: { amountPaise: number; status: string }[];
  },
  unused: number,
  total: number,
): RefundOwedMarker | null {
  if (unused <= 0 || total <= 0) return null;
  const balance = refundableBalancePaise(payment.amount, payment);
  const returned = payment.amount - balance;
  const share = Math.floor((payment.amount * Math.min(unused, total)) / total);
  const amountPaise = Math.min(share - returned, balance);
  if (amountPaise <= 0) return null;
  return {
    paymentId: payment.id,
    amountPaise,
    key: planEndRefundKey(subscriptionId, payment.id),
    reason: PLAN_END_REFUND_REASON,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
