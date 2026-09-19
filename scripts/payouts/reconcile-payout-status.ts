/**
 * Payout Status Reconciliation - Core Logic
 *
 * Reconciles payout status with payment gateways (Stripe/RazorpayX).
 * Finds PENDING/PROCESSING payouts older than 48h and queries gateways for actual status.
 *
 * This catches cases where:
 * - Payout webhook was missed or delayed
 * - DB update failed after gateway processed payout
 * - Gateway status changed without webhook
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-payout-status.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-payout-status/route.ts (API endpoint)
 *
 * Schedule: Every 6 hours
 */

import prisma from "../../lib/prisma";
import { PayoutStatus, PaymentGateway } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { handlePayoutWebhook } from "@/lib/payments/payouts";
import { resolveRazorpayXCredentials } from "@/lib/payments/payouts/razorpay-payouts";
import {
  type PayoutLookup,
  WEBHOOK_STATUS_MAP,
  getStripePayoutStatus,
  getRazorpayPayoutStatus,
  mapGatewayStatus,
  retireUnknownGatewayPayout,
} from "@/lib/payments/payouts/payout-gateway-lookup";
import { reportSentryMessage } from "@/lib/observability/report";

// Only reconcile payouts older than 48 hours (give webhooks time)
const MIN_AGE_HOURS = 48;

// Don't reconcile payouts older than 30 days
const MAX_AGE_DAYS = 30;

export interface PayoutReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  /** #1757 — rows retired FAILED because the gateway does not know their id. */
  retiredCount: number;
  retired: string[];
  discrepancies: string[];
  errors: string[];
  timestamp: string;
}

/**
 * Reconcile stale PENDING/PROCESSING payouts with gateway status
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePayoutStatus(): Promise<PayoutReconciliationResult> {
  return withCronLock(
    "reconcile-payout-status",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcilePayoutStatusUnlocked(),
  );
}

async function reconcilePayoutStatusUnlocked(): Promise<PayoutReconciliationResult> {
  const errors: string[] = [];
  const discrepancies: string[] = [];
  let reconciledCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let retiredCount = 0;
  const retired: string[] = [];

  const minAge = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Find stale PENDING or PROCESSING payouts
  const stalePayouts = await prisma.consultantPayout.findMany({
    where: {
      status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      updatedAt: {
        lt: minAge,
        gte: maxAge,
      },
      // Only payouts with gateway reference
      providerPayoutId: { not: null },
    },
    include: {
      consultantProfile: {
        include: {
          user: { select: { email: true, name: true } },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
  });

  // #1407 — the pre-flight gate has to test the credentials the lookup will
  // actually send, or it reports "configured" and every lookup still 401s.
  const razorpayXCredentials = resolveRazorpayXCredentials();
  const razorpayConfigured = !!(
    razorpayXCredentials.keyId && razorpayXCredentials.keySecret
  );
  if (!razorpayConfigured) {
    console.warn(
      "⚠️ Razorpay credentials not configured — Razorpay records will be skipped",
    );
  }

  console.log(
    `Found ${stalePayouts.length} stale PENDING/PROCESSING payouts to reconcile`,
  );

  for (const payout of stalePayouts) {
    console.log(`\nReconciling payout ${payout.id}`);
    console.log(`   Provider: ${payout.provider}`);
    console.log(`   Provider Payout ID: ${payout.providerPayoutId}`);
    console.log(`   Current Status: ${payout.status}`);
    console.log(
      `   Consultant: ${payout.consultantProfile.user.name || "Unknown"}`,
    );
    console.log(
      `   Amount: ${payout.currency} ${(payout.amount / 100).toFixed(2)}`,
    );
    console.log(`   Last updated: ${payout.updatedAt.toISOString()}`);

    // Skip if no provider payout ID
    if (!payout.providerPayoutId) {
      console.log(`   Skipping - no provider payout ID`);
      skippedCount++;
      continue;
    }

    // Query gateway for actual status
    let lookup: PayoutLookup | null = null;

    if (payout.provider === PaymentGateway.STRIPE) {
      lookup = await getStripePayoutStatus(payout.providerPayoutId);
    } else if (payout.provider === PaymentGateway.RAZORPAY) {
      if (!razorpayConfigured) {
        console.log(`   Skipping - Razorpay credentials not configured`);
        skippedCount++;
        continue;
      }
      lookup = await getRazorpayPayoutStatus(payout.providerPayoutId);
    } else {
      console.log(`   Skipping - unsupported gateway: ${payout.provider}`);
      skippedCount++;
      continue;
    }

    // #1757 — an id the gateway has no record of is terminal for this row, not
    // a run failure: FAILED via the canonical handler (releases earnings, TDS).
    if (lookup?.kind === "unknown_id") {
      await retireUnknownGatewayPayout(
        {
          provider: payout.provider,
          providerPayoutId: payout.providerPayoutId,
        },
        lookup.detail,
      );
      retiredCount++;
      retired.push(payout.id);
      continue;
    }

    if (!lookup || lookup.kind === "gateway_error") {
      console.log(`   Could not get status from gateway - skipping`);
      const detailSuffix = lookup ? ` (${lookup.detail})` : "";
      errors.push(
        `Payout ${payout.id}: Could not query gateway status${detailSuffix}`,
      );
      skippedCount++;
      continue;
    }

    const gatewayStatus = lookup;

    console.log(`   Gateway status: ${gatewayStatus.status}`);

    // Map gateway status to our status
    const mappedStatus = mapGatewayStatus(
      payout.provider,
      gatewayStatus.status,
    );

    if (!mappedStatus) {
      console.log(`   Unknown gateway status - skipping`);
      skippedCount++;
      continue;
    }

    // Update if status changed
    if (mappedStatus !== payout.status) {
      const discrepancy = `Payout ${payout.id}: DB shows ${payout.status}, gateway shows ${gatewayStatus.status} (${mappedStatus})`;
      discrepancies.push(discrepancy);
      console.log(`   ⚠️ DISCREPANCY: ${discrepancy}`);

      // #677 PM-15 — the old inline `status=COMPLETED` + `earnings PAID` flip
      // bypassed the canonical webhook handler, so on this reconcile path TDS
      // was never recorded, the payout ledger postings (revenue/payable
      // counters) never ran, and the gateway UTR was dropped. Delegate the
      // full money recording to handlePayoutWebhook, the same engine the live
      // webhook uses. It claims `status notIn [COMPLETED, CANCELLED]`, so it is
      // idempotent against a live webhook racing this reconcile — whichever
      // fires first wins and the other no-ops.
      const webhookStatus = WEBHOOK_STATUS_MAP[mappedStatus];
      if (!webhookStatus) {
        // mapGatewayStatus only yields COMPLETED/PROCESSING/FAILED/CANCELLED,
        // so this is unreachable; keep it explicit rather than silently drop.
        console.log(`   No webhook mapping for ${mappedStatus} - skipping`);
        skippedCount++;
        continue;
      }

      await handlePayoutWebhook(
        payout.provider,
        payout.providerPayoutId,
        webhookStatus,
        mappedStatus === PayoutStatus.FAILED
          ? (gatewayStatus.status.toLowerCase() === "reversed"
              ? "gateway reversed pre-completion (net-zero round trip): "
              : "") +
              (gatewayStatus.failureMessage ||
                gatewayStatus.failureReason ||
                gatewayStatus.status)
          : undefined,
        // UTR persists only on the COMPLETED branch inside the handler.
        gatewayStatus.utr,
      );

      console.log(
        `   Reconciled via webhook handler: ${payout.status} → ${mappedStatus}`,
      );
      reconciledCount++;

      if (mappedStatus === PayoutStatus.COMPLETED) {
        completedCount++;
      } else if (mappedStatus === PayoutStatus.FAILED) {
        failedCount++;
        console.log(`   ⚠️ Payout failed - consultant may need notification!`);
      }
    } else {
      console.log(`   Status unchanged (${mappedStatus})`);
    }
  }

  // Summary
  console.log("\n📊 Payout Reconciliation Summary:");
  console.log(`   Total processed: ${stalePayouts.length}`);
  console.log(`   Reconciled (status changed): ${reconciledCount}`);
  console.log(`   Completed payouts found: ${completedCount}`);
  console.log(`   Failed payouts found: ${failedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Discrepancies found: ${discrepancies.length}`);

  if (discrepancies.length > 0) {
    console.log("\n⚠️ DISCREPANCIES DETECTED:");
    discrepancies.forEach((d) => console.log(`   - ${d}`));
  }

  console.log(`   Retired (gateway does not know the id): ${retiredCount}`);

  // One expected warning per run, never one per row per tick (#1757).
  if (retiredCount > 0) {
    reportSentryMessage(
      `reconcile-payout-status: retired ${retiredCount} payout(s) whose gateway id the gateway does not know`,
      {
        subsystem: "payments",
        op: "reconcile-payout-status",
        expected: true,
        level: "warning",
        extra: { retired },
      },
    );
  }

  return {
    success: errors.length === 0,
    totalProcessed: stalePayouts.length,
    reconciledCount,
    completedCount,
    failedCount,
    skippedCount,
    discrepancies,
    retiredCount,
    retired,
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
