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
 * Imported by jobs/payments/retry-auto-refunds.ts (GitHub Actions) and
 * app/api/cleanup/retry-auto-refunds/route.ts (the ticker twin).
 */

import { PaymentStatus, RefundStatus } from "@prisma/client";

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
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
import { recordSystemError } from "@/lib/enterprise/system-events";
import { reportSentryError } from "@/lib/observability/report";

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
  timestamp: string;
}

const DEFAULT_LIMIT = 10;
/** Leaves the webhook's own Phase 2 attempt time to finish first. */
const GRACE_MS = 15 * 60_000;
/** Failed gateway refunds after which the payment goes to an operator. */
export const MAX_AUTO_REFUND_ATTEMPTS = 3;

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
    timestamp: now.toISOString(),
  };

  const due = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      deletedAt: null,
      description: { startsWith: AUTO_REFUND_PENDING_PREFIX },
      updatedAt: { lt: new Date(now.getTime() - GRACE_MS) },
      refunds: { none: { status: RefundStatus.PENDING } },
      disputes: {
        none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
      },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      description: true,
      appointmentId: true,
      refunds: {
        where: { status: RefundStatus.FAILED },
        select: { id: true },
      },
    },
  });
  result.scanned = due.length;

  // #1933 — one Sentry event per run, never per row.
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const payment of due) {
    try {
      await retryOne(payment, result);
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(payment.id);
      console.error(`retry-auto-refunds: payment ${payment.id} failed`, error);
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
  result.success = result.errors === 0;
  return result;
}

async function retryOne(
  payment: {
    id: string;
    description: string | null;
    appointmentId: string | null;
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

  try {
    await refundBookingPayment({
      paymentId: payment.id,
      reason: "auto-refund retry: capture funds no booking",
      initiatedByUserId: null,
    });
    result.refunded += 1;
  } catch (error) {
    if (
      error instanceof RefundValidationError &&
      error.code === "ALREADY_FULLY_REFUNDED"
    ) {
      // The money is already back (an earlier attempt or an operator).
      result.settled += 1;
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
  await settleAutoRefundMarker(payment.id);
}
