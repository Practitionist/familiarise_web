/**
 * Stuck Payouts Handler - Core Logic
 *
 * Handles payouts stuck in PROCESSING status for too long.
 * Queries payment gateways to get actual status and updates DB.
 * Retries failed payouts up to MAX_RETRIES.
 *
 * This catches cases where:
 * - Payout webhook was missed or delayed
 * - Gateway processed but DB update failed
 * - Network timeout during payout processing
 *
 * This module exports the core handler function.
 * It is imported by:
 * - jobs/handle-stuck-payouts.ts (GitHub Actions)
 * - app/api/cleanup/handle-stuck-payouts/route.ts (API endpoint)
 *
 * Schedule: Every 4 hours
 */

import prisma from "../../lib/prisma";
import { PayoutStatus, PaymentGateway, EarningStatus } from "@prisma/client";
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

// Consider payouts stuck if in PROCESSING for more than 24 hours
const STUCK_THRESHOLD_HOURS = 24;

// Maximum retry attempts before marking as permanently FAILED
const MAX_RETRIES = 3;

export interface StuckPayoutsResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  retriedCount: number;
  failedCount: number;
  skippedCount: number;
  /** #1757 — rows retired FAILED because the gateway does not know their id. */
  retiredCount: number;
  retired: string[];
  errors: string[];
  timestamp: string;
}

/**
 * Find and handle stuck payouts
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function handleStuckPayouts(): Promise<StuckPayoutsResult> {
  return withCronLock(
    "handle-stuck-payouts",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => handleStuckPayoutsUnlocked(),
  );
}

async function handleStuckPayoutsUnlocked(): Promise<StuckPayoutsResult> {
  const errors: string[] = [];
  let reconciledCount = 0;
  let retriedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let retiredCount = 0;
  const retired: string[] = [];

  const stuckThreshold = new Date(
    Date.now() - STUCK_THRESHOLD_HOURS * 60 * 60 * 1000,
  );

  // Find payouts stuck in PROCESSING for too long
  const stuckPayouts = await prisma.consultantPayout.findMany({
    where: {
      status: PayoutStatus.PROCESSING,
      updatedAt: { lt: stuckThreshold },
    },
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
    },
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
    `Found ${stuckPayouts.length} payouts stuck in PROCESSING for >${STUCK_THRESHOLD_HOURS}h`,
  );

  for (const payout of stuckPayouts) {
    console.log(
      `\nProcessing stuck payout ${payout.id} for ${payout.consultantProfile.user.name || "Unknown"}`,
    );
    console.log(
      `   Amount: ${payout.currency} ${(payout.amount / 100).toFixed(2)}`,
    );
    console.log(`   Provider: ${payout.provider}`);
    console.log(`   Provider Payout ID: ${payout.providerPayoutId || "none"}`);
    console.log(`   Last updated: ${payout.updatedAt.toISOString()}`);
    console.log(`   Retry count: ${payout.retryCount}`);

    // If no provider payout ID, mark as failed (never sent to gateway)
    if (!payout.providerPayoutId) {
      console.log(`   No provider payout ID - marking as FAILED`);

      if (payout.retryCount >= MAX_RETRIES) {
        // #1205-triage — CAS the terminal flip inside the same tx as the
        // earnings release: without the PROCESSING guard, a concurrently
        // completing gateway webhook could be overwritten by this FAILED.
        const cas = await prisma.$transaction(async (tx) => {
          const claimed = await tx.consultantPayout.updateMany({
            where: { id: payout.id, status: PayoutStatus.PROCESSING },
            data: {
              status: PayoutStatus.FAILED,
              failureReason:
                "Payout never sent to gateway after multiple attempts",
            },
          });
          if (claimed.count === 0) return { released: 0, claimed: false };
          const released = await tx.consultantEarnings.updateMany({
            where: { payoutId: payout.id, status: EarningStatus.BATCHED },
            data: { payoutId: null, status: EarningStatus.READY },
          });
          return { released: released.count, claimed: true };
        });
        failedCount++;
        if (!cas.claimed) {
          console.log(
            `   Skipped — payout left PROCESSING concurrently (webhook won)`,
          );
        } else {
          console.log(
            `   Marked as permanently FAILED (max retries reached); released ${cas.released} earning(s)`,
          );
        }
      } else {
        // #1407 — CAS the retry reset, like every sibling write in this loop.
        // The interleaving: the cohort is read once, then each payout costs a
        // gateway HTTP round-trip; while this job is out on an earlier
        // element, a concurrent process-payouts run or a payout webhook can
        // move a LATER one. The bare `update` carried no guard, so it stamped
        // that row back to APPROVED from whatever it had become and the next
        // batch paid it twice.
        const reset = await prisma.consultantPayout.updateMany({
          where: {
            id: payout.id,
            status: PayoutStatus.PROCESSING,
            providerPayoutId: null,
          },
          data: {
            status: PayoutStatus.APPROVED,
            retryCount: { increment: 1 },
          },
        });
        if (reset.count === 0) {
          // Whoever moved it owns the row now — never re-arm it from here.
          skippedCount++;
          console.log(
            `   Skipped — raced: a concurrent process-payouts run or payout webhook moved it`,
          );
        } else {
          retriedCount++;
          console.log(
            `   Reset to APPROVED for retry (attempt ${payout.retryCount + 1})`,
          );
        }
      }
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
      console.log(
        `   Unknown gateway status: ${gatewayStatus.status} - skipping`,
      );
      errors.push(
        `Payout ${payout.id}: Unknown gateway status ${gatewayStatus.status}`,
      );
      continue;
    }

    // Update if status changed
    if (mappedStatus !== payout.status) {
      // PM-15 — the old inline `status=COMPLETED` + `earnings PAID` flip
      // bypassed the canonical webhook handler, so on this reconcile path TDS
      // was never recorded, the payout ledger postings (the revenue/payable
      // counters) never ran, and the gateway UTR was dropped. Delegate the
      // full money recording to handlePayoutWebhook, the same engine the live
      // webhook uses. It claims `status notIn [COMPLETED, CANCELLED]`, so it is
      // idempotent against a live webhook racing this reconcile — whichever
      // fires first wins and the other no-ops. The UTR persists only on the
      // COMPLETED branch inside the handler.
      const webhookStatus = WEBHOOK_STATUS_MAP[mappedStatus];
      if (!webhookStatus) {
        // mapGatewayStatus only yields COMPLETED/PROCESSING/FAILED/CANCELLED,
        // so this is unreachable; keep it explicit rather than silently drop.
        console.log(`   No webhook mapping for ${mappedStatus} - skipping`);
        continue;
      }

      await handlePayoutWebhook(
        payout.provider,
        payout.providerPayoutId,
        webhookStatus,
        mappedStatus === PayoutStatus.FAILED
          ? gatewayStatus.failureMessage || gatewayStatus.failureReason
          : undefined,
        gatewayStatus.utr,
      );

      console.log(
        `   Reconciled via webhook handler: ${payout.status} → ${mappedStatus}`,
      );
      reconciledCount++;
    } else {
      console.log(`   Status unchanged (${mappedStatus})`);
    }
  }

  // Summary
  console.log("\n📊 Stuck Payouts Summary:");
  console.log(`   Total processed: ${stuckPayouts.length}`);
  console.log(`   Reconciled: ${reconciledCount}`);
  console.log(`   Reset for retry: ${retriedCount}`);
  console.log(`   Permanently failed: ${failedCount}`);
  console.log(`   Skipped: ${skippedCount}`);

  console.log(`   Retired (gateway does not know the id): ${retiredCount}`);

  // One expected warning per run, never one per row per tick (#1757).
  if (retiredCount > 0) {
    reportSentryMessage(
      `handle-stuck-payouts: retired ${retiredCount} payout(s) whose gateway id the gateway does not know`,
      {
        subsystem: "payments",
        op: "handle-stuck-payouts",
        expected: true,
        level: "warning",
        extra: { retired },
      },
    );
  }

  return {
    success: errors.length === 0,
    totalProcessed: stuckPayouts.length,
    reconciledCount,
    retriedCount,
    failedCount,
    skippedCount,
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
