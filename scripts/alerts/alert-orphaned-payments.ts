/**
 * Orphaned Payments Alert - Core Logic
 *
 * Finds payments where status = SUCCEEDED but no appointment exists.
 * These are CRITICAL cases where a customer was charged but got nothing.
 *
 * This catches cases where:
 * - App crash after payment succeeded but before appointment created
 * - Webhook processed payment but appointment creation failed
 * - Race condition between payment and appointment creation
 *
 * This module exports the core alert function.
 * It is imported by:
 * - jobs/alert-orphaned-payments.ts (GitHub Actions)
 * - app/api/cleanup/alert-orphaned-payments/route.ts (API endpoint)
 *
 * Schedule: every 15 minutes via the Netlify ticker, daily Actions backstop.
 *
 * #1846 — this detector is the ONLY one in the fleet that reported a P0-class
 * condition through `console.error` alone. Money captured, nothing booked, and
 * the sole evidence was a log line in a Netlify function log that nobody reads
 * and that expires. It also returned `success: true` with `criticalCount > 0`,
 * so every health signal that reads the run's own success flag — the
 * `SystemJobExecution` row, the route's HTTP status, the Actions wrapper's
 * exit code — reported a detector that found a critical condition as a
 * detector that worked. Both are fixed below: a durable `SystemEvent` per
 * payment (the ops trail, deduped so re-runs do not pile up rows) plus a
 * Sentry report, and an honest success flag.
 */

import prisma from "../../lib/prisma";
import { PaymentStatus, RefundStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import {
  REPLAY_SALE_PREFIX,
  notSettledElsewhereWhere,
} from "@/lib/payments/webhooks/auto-refund-marker";

/** The `SystemEvent.category` every orphaned-payment row is filed under. */
const EVENT_CATEGORY = "PAYMENT";

// Only check payments within the last 7 days
const ALERT_WINDOW_DAYS = 7;

export interface OrphanedPaymentsAlertResult {
  success: boolean;
  totalOrphaned: number;
  criticalCount: number;
  totalAmount: number;
  /** By-design null-appointment side-charges, excluded from the critical cohort. */
  sideChargeCount: number;
  orphanedPayments: Array<{
    id: string;
    paymentIntent: string | null;
    amount: number;
    currency: string;
    gateway: string;
    userEmail: string | null;
    createdAt: Date;
  }>;
  errors: string[];
  timestamp: string;
}

/**
 * Record one orphaned payment as a durable operational event.
 *
 * `correlationId` is the dedupe key and it is PER PAYMENT, not per run: the job
 * re-reads a seven-day window every six hours, so a run-scoped key would mint
 * a fresh row on every pass for the same unresolved payment and bury the one
 * that matters. Per-payment means the row is written once, on the run that
 * first saw it, and a later run reads it back and stays quiet — which is the
 * behaviour the sibling sweeps rely on (see `escalateHeldPaidSeat` in
 * settle-cancelled-sessions.ts, the same shape).
 *
 * `strict: false` and the `Safe` wrapper on purpose: this is telemetry about a
 * broken payment, not the audit record of the payment itself, so a failed
 * insert must not take the detector down with it. The failure is reported by
 * the wrapper's own marker rather than vanishing.
 */
async function recordOrphanedPayment(payment: {
  id: string;
  paymentIntent: string | null;
  gatewayPaymentId: string | null;
  amount: number;
  currency: string;
  paymentGateway: string;
  createdAt: Date;
  user: { email: string | null; name: string | null } | null;
}): Promise<boolean> {
  const correlationId = `orphaned-payment:${payment.id}`;
  const seen = await prisma.systemEvent.findFirst({
    where: { correlationId },
    select: { id: true },
  });
  if (seen) return false;

  await recordSystemEventSafe({
    category: EVENT_CATEGORY,
    // ERROR, not WARN: a SUCCEEDED payment with no booking is money taken for
    // nothing, and the only remedies are a refund or a re-drive, both of which
    // need a human. The severity is what puts it in front of one.
    severity: "ERROR",
    message:
      `SUCCEEDED payment ${payment.id} has no appointment — ` +
      `customer charged ${payment.currency} ${(payment.amount / 100).toFixed(2)} and nothing was booked`,
    context: {
      paymentId: payment.id,
      // The gateway ids are what an operator reconciles against; without them
      // the row says "a payment is orphaned" and not which one at the bank.
      paymentIntent: payment.paymentIntent,
      gatewayPaymentId: payment.gatewayPaymentId,
      gateway: payment.paymentGateway,
      amountPaise: Number(payment.amount),
      currency: payment.currency,
      // Present in the row, never rendered to an org, so the PII boundary the
      // SystemEvent docstring draws holds.
      userEmail: payment.user?.email ?? null,
      capturedAt: payment.createdAt.toISOString(),
    },
    correlationId,
  });
  return true;
}

/**
 * Find succeeded payments without appointments and alert
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function alertOrphanedPayments(
  opts: { limit?: number } = {},
): Promise<OrphanedPaymentsAlertResult> {
  return withCronLock("alert-orphaned-payments", { failMode: "open" }, () =>
    alertOrphanedPaymentsUnlocked(opts),
  );
}

async function alertOrphanedPaymentsUnlocked(
  opts: { limit?: number } = {},
): Promise<OrphanedPaymentsAlertResult> {
  const errors: string[] = [];
  let criticalCount = 0;
  let totalAmount = 0;

  const sevenDaysAgo = new Date(
    Date.now() - ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  // Find succeeded payments without appointments, oldest first so a backlog
  // drains in arrival order. Side-charges carry appointmentId null by design,
  // so they are excluded from the critical cohort and counted separately;
  // replay sales and auto-refund markers are settled by their own rails.
  const rawOrphanedPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
      deletedAt: null,
      parentPaymentId: null,
      NOT: { paymentIntent: { startsWith: "overage:" } },
      AND: [notSettledElsewhereWhere],
      createdAt: { gte: sevenDaysAgo },
      refunds: {
        none: {
          status: RefundStatus.PENDING,
        },
      },
    },
    include: {
      user: {
        select: { email: true, name: true },
      },
      refunds: {
        where: { status: RefundStatus.SUCCEEDED },
        select: { amountPaise: true },
      },
    },
    orderBy: { createdAt: "asc" },
    ...(opts.limit !== undefined ? { take: opts.limit } : {}),
  });

  const orphanedPayments = rawOrphanedPayments.filter((payment) => {
    const refundedAmount = Array.isArray(payment.refunds)
      ? payment.refunds.reduce(
          (sum: number, r: { amountPaise?: number; amount?: number }) =>
            sum + Number(r.amountPaise ?? r.amount ?? 0),
          0,
        )
      : 0;
    return refundedAmount < payment.amount;
  });

  const sideChargeCount = await prisma.payment.count({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
      createdAt: { gte: sevenDaysAgo },
      OR: [
        { parentPaymentId: { not: null } },
        { paymentIntent: { startsWith: "overage:" } },
        { description: { startsWith: REPLAY_SALE_PREFIX } },
      ],
    },
  });

  console.log(
    `Found ${orphanedPayments.length} orphaned payments (SUCCEEDED but no appointment)`,
  );

  // Format for logging and return
  const formattedOrphaned = orphanedPayments.map((payment) => {
    totalAmount += payment.amount;
    criticalCount++;

    // Log each orphaned payment as CRITICAL. The log is kept as the tail of the
    // run — it is useful in a deploy and it is free — but it is no longer the
    // only copy, and it is not what pages anyone.
    console.error(`CRITICAL: Orphaned payment ${payment.id}`);
    console.error(
      `   User: ${payment.user?.name || "Unknown"} (${payment.user?.email || "no email"})`,
    );
    console.error(
      `   Amount: ${payment.currency} ${(payment.amount / 100).toFixed(2)}`,
    );
    console.error(`   Gateway: ${payment.paymentGateway}`);
    console.error(`   Payment Intent: ${payment.paymentIntent}`);
    console.error(`   Created: ${payment.createdAt.toISOString()}`);
    console.error(`   ACTION REQUIRED: Manual recovery needed!`);
    console.error("");

    return {
      id: payment.id,
      paymentIntent: payment.paymentIntent,
      amount: payment.amount,
      currency: payment.currency,
      gateway: payment.paymentGateway,
      userEmail: payment.user?.email || null,
      createdAt: payment.createdAt,
    };
  });

  // #1846 — the durable trail and the page. One SystemEvent per NEWLY seen
  // payment, and one Sentry report for the run, so a six-hourly re-run of the
  // same unresolved payment does not turn into a notification every six hours.
  let newlyRecorded = 0;
  for (const payment of orphanedPayments) {
    try {
      if (await recordOrphanedPayment(payment)) newlyRecorded += 1;
    } catch (error) {
      // Counted, never thrown: one failed insert must not stop the sweep
      // recording the rest, and the run's success flag below goes false so the
      // failure is still visible to every caller.
      const msg = `Failed to record orphaned payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  // Summary
  if (orphanedPayments.length > 0) {
    console.log("\n========================================");
    console.log("CRITICAL ALERT: ORPHANED PAYMENTS FOUND");
    console.log("========================================");
    console.log(`Total orphaned: ${orphanedPayments.length}`);
    console.log(`Total amount: ${(totalAmount / 100).toFixed(2)}`);
    console.log(`Newly recorded as SystemEvents: ${newlyRecorded}`);
    console.log("These customers were charged but have no appointment!");
    console.log("Manual recovery is required for each case.");
    console.log("========================================\n");

    // One report per RUN when newly seen orphaned payments arrive, not per
    // payment and not on every 15-minute re-read of an already-recorded cohort:
    // a large or already-known cohort would otherwise spend the month's error
    // allowance on the same incident.
    if (newlyRecorded > 0) {
      reportSentryMessage(
        "Orphaned payments: customers charged with no booking",
        {
          subsystem: "payments",
          op: "alert-orphaned-payments",
          level: "error",
          fingerprint: ["orphaned-payments"],
          extra: {
            totalOrphaned: orphanedPayments.length,
            newlyRecorded,
            totalAmount,
            totalAmountPaise: totalAmount,
            sideChargeCount,
            sample: formattedOrphaned.slice(0, 10).map((p) => p.id),
            paymentIds: orphanedPayments.slice(0, 25).map((p) => p.id),
          },
        },
      );
    }
  } else {
    console.log("No orphaned payments found - all payments have appointments.");
  }

  return {
    // #1846 — honest. The run succeeded AND found a critical condition, and
    // the flag is the only thing three separate callers read: the route maps
    // `success: false` to a 500, the Actions wrapper uses it for the exit
    // code, and `SystemJobExecution` records it. Returning true here made every
    // one of them report a detected P0 as a healthy run. A non-zero
    // `criticalCount` is the run's own definition of "needs a human", which is
    // what `statusFor`'s 207 exists for on the other sweeps.
    success: errors.length === 0 && criticalCount === 0,
    totalOrphaned: orphanedPayments.length,
    criticalCount,
    totalAmount,
    sideChargeCount,
    orphanedPayments: formattedOrphaned,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
