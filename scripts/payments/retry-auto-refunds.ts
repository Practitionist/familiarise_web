/**
 * #1846 N2 — retry the auto-refunds the confirmation pipeline owes.
 *
 * Five Phase-2 branches of the capture webhook refund money that funds no
 * booking, and each tried the refund door exactly once. A gateway 5xx or a
 * killed function left the buyer charged with no booking and nothing to move
 * the money back. Phase 1 now stamps `Auto-refund pending:` on the payment in
 * the transaction that decides the refund (see
 * lib/payments/webhooks/auto-refund-marker.ts), which makes the SUCCEEDED
 * payment carrying that prefix an exact work queue: state-as-outbox, no queue
 * table (ADR 27).
 *
 * Each run takes a bounded bite, oldest first, and skips what another actor
 * owns: a payment with a PENDING refund belongs to reconcile-refunds, and one
 * under a live dispute cannot be refunded until it resolves. The refund door
 * reserves the amount under Serializable isolation, so a racing Phase 2 or a
 * second runner cannot over-refund. After MAX_ATTEMPTS refunds have failed at
 * the gateway the marker becomes `Auto-refund stuck:` and an operator is paged
 * once, instead of retrying (and telling the payer the refund failed) forever.
 *
 * A second cohort drains the refunds the booking doors owe: a cancel,
 * rejection, moderation ban, maintenance freeze or no-show stamps
 * `Payment.refundOwedKey` in the commit that ends the booking, and this sweep
 * drives each marker under its own key until the money is back. A failed drive
 * waits out `refundOwedNextAt` (1 h, then 4 h), the attempt count retires a
 * marker to an operator at MAX_REFUND_OWED_ATTEMPTS, and markers older than
 * six hours, past the backoff's last retry, are surfaced once a day as an ops event.
 *
 * Imported by jobs/payments/retry-auto-refunds.ts (GitHub Actions) and
 * app/api/cleanup/retry-auto-refunds/route.ts (the ticker twin).
 */

import { createHash } from "node:crypto";
import {
  PaymentGateway,
  PaymentStatus,
  RefundStatus,
  type Prisma,
} from "@prisma/client";

import prisma, { type PrismaLike } from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { parkedReceiptPaise } from "@/lib/payments/ledger/unapplied-receipts";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import {
  RefundGatewayError,
  RefundValidationError,
} from "@/lib/payments/operations/refund";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  AUTO_REFUND_PENDING_PREFIX,
  DOUBLE_BOOKING_BLOCKED_NOTE,
  stuckAutoRefundDescription,
} from "@/lib/payments/webhooks/auto-refund-marker";
import {
  releaseBlockedBookingHold,
  settleAutoRefundMarker,
} from "@/lib/payments/webhooks/handlers";
import {
  recordSystemError,
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import {
  driveRefundOwed,
  markerFromRow,
  MAX_REFUND_OWED_ATTEMPTS,
  REFUND_OWED_SELECT,
  type RefundOwedMarker,
  type RefundOwedOutcome,
} from "@/lib/payments/operations/refund-owed";
import { stampTrialEarningsOnCancel } from "@/lib/trials/cancellation";
import { recordGatewayRefunds } from "@/lib/payments/webhooks/gateway-refund-import";
import { isMockPaymentId } from "@/lib/payments/operations/mock";
import { reportSentryError } from "@/lib/observability/report";
import { startDeadline, startDeadlineShare } from "@/lib/cron/run-deadline";
import { scrubStringValue } from "@/lib/observability/sentry-scrubber";

export interface RetryAutoRefundsResult {
  success: boolean;
  scanned: number;
  /** Refunds this run issued. */
  refunded: number;
  /** Markers settled because the money was already back. */
  settled: number;
  /** Gateway failures; the reservation is left to reconcile-refunds. */
  failed: number;
  /** Payments whose attempt budget ran out this run; an operator was paged. */
  stuck: string[];
  errors: number;
  /** The refund-owed cohort: markers the booking doors stamped. */
  owed: {
    scanned: number;
    refunded: number;
    /** Cleared because the money was already back. */
    settled: number;
    /** Drives that failed and stay on the marker. */
    failed: number;
    /** Markers retired to an operator this run. */
    stuck: string[];
    /** Markers older than six hours, stuck ones included. */
    aged: number;
  };
  /** The run hit its start deadline with rows left for the next one. */
  hasMore: boolean;
  timestamp: string;
}

const DEFAULT_LIMIT = 10;
/** Leaves the webhook's own Phase 2 attempt time to finish first. */
const GRACE_MS = 15 * 60_000;
/** Failed gateway refunds after which the payment goes to an operator. */
export const MAX_AUTO_REFUND_ATTEMPTS = 3;
/** A refund owed this long after its door committed is surfaced to ops. */
const OWED_ALERT_AFTER_MS = 6 * 60 * 60_000;
const OWED_REPORT_WINDOW_MS = 24 * 60 * 60_000;
/** Bounds the read of a capture's gateway refunds before its retry. */
const GATEWAY_REFUNDS_READ_TIMEOUT_MS = 10_000;

/** Pending auto-refund markers past the webhook's grace. */
function autoRefundDueWhere(now: Date): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.SUCCEEDED,
    deletedAt: null,
    description: { startsWith: AUTO_REFUND_PENDING_PREFIX },
    updatedAt: { lt: new Date(now.getTime() - GRACE_MS) },
    refunds: { none: { status: RefundStatus.PENDING } },
    disputes: {
      none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    },
  };
}

/** Owed-refund markers due a drive; a failed drive waits out its next-drive time. */
function refundOwedDueWhere(now: Date): Prisma.PaymentWhereInput {
  return {
    refundOwedKey: { not: null },
    refundOwedAt: { lt: new Date(now.getTime() - GRACE_MS) },
    refundOwedAttempts: { lt: MAX_REFUND_OWED_ATTEMPTS },
    OR: [{ refundOwedNextAt: null }, { refundOwedNextAt: { lte: now } }],
    paymentStatus: PaymentStatus.SUCCEEDED,
    deletedAt: null,
    refunds: { none: { status: RefundStatus.PENDING } },
    disputes: {
      none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    },
  };
}

/** Owed-refund markers old enough for the ops report. */
function agedRefundOwedWhere(now: Date): Prisma.PaymentWhereInput {
  return {
    refundOwedKey: { not: null },
    refundOwedAt: { lt: new Date(now.getTime() - OWED_ALERT_AFTER_MS) },
    paymentStatus: PaymentStatus.SUCCEEDED,
    deletedAt: null,
  };
}

/** True when any arm (auto-refund retry, owed drive, aged-marker report) has a row. */
export async function hasAutoRefundRetryWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.payment.findFirst({
    where: {
      OR: [
        autoRefundDueWhere(now),
        refundOwedDueWhere(now),
        agedRefundOwedWhere(now),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

// #476 — one lock for every entry; fail-closed because this sweep refunds.
export async function retryAutoRefunds(
  opts: { limit?: number } = {},
): Promise<RetryAutoRefundsResult> {
  return withCronLock("retry-auto-refunds", { failMode: "closed" }, () =>
    retryUnlocked(opts.limit ?? DEFAULT_LIMIT),
  );
}

async function retryUnlocked(limit: number): Promise<RetryAutoRefundsResult> {
  const now = new Date();
  const result: RetryAutoRefundsResult = {
    success: true,
    scanned: 0,
    refunded: 0,
    settled: 0,
    failed: 0,
    stuck: [],
    errors: 0,
    owed: {
      scanned: 0,
      refunded: 0,
      settled: 0,
      failed: 0,
      stuck: [],
      aged: 0,
    },
    hasMore: false,
    timestamp: now.toISOString(),
  };
  // One deadline for the run: a slow gateway cuts it between rows, never mid-row.
  // Auto-refunds stop at half of it, so they never starve the owed markers.
  const startedAt = Date.now();
  const outOfTime = startDeadline(startedAt);
  const autoRefundsOutOfTime = startDeadlineShare(0.5, startedAt);

  const due = await prisma.payment.findMany({
    where: autoRefundDueWhere(now),
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      description: true,
      appointmentId: true,
      paymentGateway: true,
      paymentIntent: true,
      gatewayPaymentId: true,
      refunds: {
        where: { status: RefundStatus.FAILED },
        select: { id: true },
      },
    },
  });
  result.scanned = due.length;

  // One Sentry event per run, never per row.
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const payment of due) {
    if (autoRefundsOutOfTime()) {
      result.hasMore = true;
      break;
    }
    try {
      await retryOne(payment, result);
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(payment.id);
      // Console bypasses the Sentry scrubber, so log a scrubbed message only.
      console.error(
        `retry-auto-refunds: payment ${payment.id} failed:`,
        scrubStringValue(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "payments",
      op: "retry-auto-refunds",
      fingerprint: ["retry-auto-refunds"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
  await retryRefundsOwed(limit, now, result, outOfTime);
  await reportAgedRefundsOwed(now, result);
  result.success = result.errors === 0;
  return result;
}

/**
 * Drive the oldest markers, fewest attempts first so a failing row rotates
 * behind fresh ones. A payment with a PENDING refund belongs to
 * reconcile-refunds and one under a live dispute waits for it; a marker whose
 * key already carries a settled refund is cleared by the drive's replay.
 */
async function retryRefundsOwed(
  limit: number,
  now: Date,
  result: RetryAutoRefundsResult,
  outOfTime: () => boolean,
): Promise<void> {
  const rows = await prisma.payment.findMany({
    where: refundOwedDueWhere(now),
    orderBy: [{ refundOwedAttempts: "asc" }, { refundOwedAt: "asc" }],
    take: limit,
    select: REFUND_OWED_SELECT,
  });
  result.owed.scanned = rows.length;

  // One Sentry event per run, never per row.
  let firstError: unknown;
  const failedIds: string[] = [];
  for (const marker of rows.flatMap((row) => markerFromRow(row) ?? [])) {
    if (outOfTime()) {
      result.hasMore = true;
      break;
    }
    const outcome = await driveRefundOwed(marker, { initiatedByUserId: null });
    const holdError = await startTrialHoldIfSettled(marker, outcome);
    if (holdError !== undefined) {
      result.errors += 1;
      firstError ??= holdError;
      failedIds.push(marker.paymentId);
    }
    if (outcome.kind === "refunded") result.owed.refunded += 1;
    else if (outcome.kind === "replayed" || outcome.kind === "settled") {
      result.owed.settled += 1;
    } else if (outcome.kind === "failed") {
      result.owed.failed += 1;
      // A permanent failure already paged once through its stuck alert.
      if (!outcome.permanent) {
        firstError ??= outcome.error;
        failedIds.push(marker.paymentId);
      }
      if (outcome.stuck) result.owed.stuck.push(marker.paymentId);
    }
  }
  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "payments",
      op: "retry-auto-refunds.owed",
      fingerprint: ["retry-auto-refunds", "owed"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
}

/**
 * A settled trial refund starts the retained earnings' hold; the credits rail
 * has no cascade to do it, and the stamp is idempotent. A failed stamp is
 * returned for the run's one report and recorded durably, because the marker
 * is already cleared.
 */
async function startTrialHoldIfSettled(
  marker: RefundOwedMarker,
  outcome: RefundOwedOutcome,
): Promise<unknown> {
  const settled =
    outcome.kind === "settled" ||
    ((outcome.kind === "refunded" || outcome.kind === "replayed") &&
      outcome.refund.status !== "PENDING");
  if (!settled || !marker.key.startsWith("trial-cancel:")) return undefined;
  try {
    await stampTrialEarningsOnCancel(prisma, { paymentId: marker.paymentId });
    return undefined;
  } catch (error) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: `Trial refund settled for payment ${marker.paymentId} but its earnings hold was not started`,
      err: error,
      context: { paymentId: marker.paymentId, key: marker.key },
    });
    return error ?? new Error("trial hold stamp failed");
  }
}

/**
 * Markers older than six hours are money a booking door still owes. The ops
 * event reads the persisted owed amount and is recorded once per distinct id
 * set per day, so a stuck backlog does not re-page every tick.
 */
async function reportAgedRefundsOwed(
  now: Date,
  result: RetryAutoRefundsResult,
): Promise<void> {
  const aged = await prisma.payment.findMany({
    where: agedRefundOwedWhere(now),
    orderBy: { refundOwedAt: "asc" },
    take: 200,
    select: {
      id: true,
      refundOwedKey: true,
      refundOwedPaise: true,
      refundOwedAttempts: true,
    },
  });
  result.owed.aged = aged.length;
  if (aged.length === 0) return;

  const ids = aged.map((p) => p.id);
  const correlationId = `retry-auto-refunds:owed:${createHash("sha256")
    // Code-unit order, not localeCompare: a dedupe key must not vary by collation.
    .update([...ids].sort((a, b) => Number(a > b) - Number(a < b)).join(","))
    .digest("hex")
    .slice(0, 16)}`;
  const reported = await prisma.systemEvent
    .findFirst({
      where: {
        correlationId,
        createdAt: { gte: new Date(now.getTime() - OWED_REPORT_WINDOW_MS) },
      },
      select: { id: true },
    })
    .catch(() => null);
  if (reported) return;
  await recordSystemEvent({
    category: "PAYMENT",
    severity: "WARN",
    message: `${aged.length} cancelled or ended bookings still owe a refund more than 6 h after their door committed`,
    context: {
      owed: aged.slice(0, 50).map((p) => ({
        paymentId: p.id,
        key: p.refundOwedKey,
        // Null is the full remaining balance, as stamped.
        owedPaise: p.refundOwedPaise,
        attempts: p.refundOwedAttempts,
      })),
    },
    correlationId,
  });
}

/**
 * The parked capture still owed back, clamped to the refundable balance; null
 * when nothing was parked (the full balance is then the right call).
 */
async function parkedRefundPaise(
  paymentId: string,
): Promise<number | undefined> {
  const parked = await parkedReceiptPaise(prisma, paymentId);
  if (parked === null) return undefined;
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  const refundable = row ? refundableBalancePaise(Number(row.amount), row) : 0;
  return Math.max(0, Math.min(parked, refundable));
}

async function retryOne(
  payment: {
    id: string;
    description: string | null;
    appointmentId: string | null;
    paymentGateway: PaymentGateway;
    paymentIntent: string;
    gatewayPaymentId: string | null;
    refunds: { id: string }[];
  },
  result: RetryAutoRefundsResult,
): Promise<void> {
  const pending = payment.description ?? "";

  if (payment.refunds.length >= MAX_AUTO_REFUND_ATTEMPTS) {
    // CAS on the marker: only the run that retires it pages. The handoff row
    // commits with the retirement, so a killed run leaves the pending marker
    // for the next sweep instead of a stuck one nobody was told about.
    const retired = await prisma.$transaction(async (tx) => {
      const moved = await tx.payment.updateMany({
        where: { id: payment.id, description: pending },
        data: { description: stuckAutoRefundDescription(pending) },
      });
      if (moved.count === 0) return false;
      await recordSystemError({
        organizationId: null,
        category: "PAYMENT",
        summary: `Auto-refund of payment ${payment.id} failed ${payment.refunds.length} times — refund by hand`,
        err: new Error("AUTO_REFUND_STUCK"),
        context: { paymentId: payment.id, marker: pending },
        db: tx,
      });
      return true;
    });
    if (retired) result.stuck.push(payment.id);
    return;
  }

  // Refunds already made at the gateway (the dashboard included) are recorded first, so only the rest is asked for.
  if (
    payment.paymentGateway === PaymentGateway.RAZORPAY &&
    payment.gatewayPaymentId?.startsWith("pay_") &&
    !isMockPaymentId(payment.gatewayPaymentId)
  ) {
    const { pendingAtGateway } = await recordGatewayRefunds(
      payment.paymentIntent,
      payment.gatewayPaymentId,
      Date.now() + GATEWAY_REFUNDS_READ_TIMEOUT_MS,
    );
    // The PENDING row now belongs to reconcile-refunds; the next run sees its outcome.
    if (pendingAtGateway) return;
  }

  let settled = false;
  try {
    const amountPaise = await parkedRefundPaise(payment.id);
    if (amountPaise === 0) {
      // Everything the gateway captured has already gone back.
      result.settled += 1;
      settled = true;
    } else {
      const outcome = await refundBookingPayment({
        paymentId: payment.id,
        // Only what the gateway actually captured can go back; a short
        // capture is never retried for the ordered amount.
        ...(amountPaise === undefined ? {} : { amountPaise }),
        reason: "auto-refund retry: capture funds no booking",
        initiatedByUserId: null,
      });
      result.refunded += 1;
      settled = outcome?.status !== "PENDING";
    }
  } catch (error) {
    if (
      error instanceof RefundValidationError &&
      error.code === "ALREADY_FULLY_REFUNDED"
    ) {
      // The money is already back (an earlier attempt or an operator).
      result.settled += 1;
      settled = true;
    } else if (
      error instanceof RefundValidationError &&
      (error.code === "REFUND_BLOCKED_BY_DISPUTE" ||
        error.code === "AMOUNT_EXCEEDS_REFUNDABLE")
    ) {
      // A dispute opened or a concurrent refund reserved the balance after
      // the read; that actor owns the payment now, and the next run sees it.
      return;
    } else if (error instanceof RefundGatewayError) {
      // The reservation row now belongs to reconcile-refunds; a FAILED
      // outcome counts towards the attempt budget on a later run.
      result.failed += 1;
      return;
    } else {
      throw error;
    }
  }

  if (payment.appointmentId && pending.includes(DOUBLE_BOOKING_BLOCKED_NOTE)) {
    await releaseBlockedBookingHold(payment.appointmentId);
  }
  if (settled) {
    await settleAutoRefundMarker(payment.id);
  }
}
