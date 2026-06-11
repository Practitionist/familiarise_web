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
import { PayoutStatus, PaymentGateway } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

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
  errors: string[];
  timestamp: string;
}

/**
 * Query Stripe for payout/transfer status
 */
async function getStripePayoutStatus(
  providerPayoutId: string,
): Promise<{ status: string; failureMessage?: string } | null> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return null;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Check if it's a transfer (tr_) or payout (po_)
    if (providerPayoutId.startsWith("tr_")) {
      const transfer = await stripe.transfers.retrieve(providerPayoutId);
      return {
        status: transfer.reversed ? "reversed" : "paid",
      };
    } else if (providerPayoutId.startsWith("po_")) {
      const payout = await stripe.payouts.retrieve(providerPayoutId);
      return {
        status: payout.status,
        failureMessage: payout.failure_message || undefined,
      };
    }

    return null;
  } catch (error) {
    console.error(`Failed to get Stripe payout status: ${error}`);
    return null;
  }
}

/**
 * Query RazorpayX for payout status
 */
async function getRazorpayPayoutStatus(
  providerPayoutId: string,
): Promise<{ status: string; failureReason?: string } | null> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  // #677 PM-1 — prod env defines RAZORPAY_SECRET (the canonical name the
  // core lib reads); reading only RAZORPAY_KEY_SECRET silently disabled
  // this reconciliation in production while it looked green.
  const keySecret =
    process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.warn("RazorpayX credentials not configured");
    return null;
  }

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payouts/${providerPayoutId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );

    if (!response.ok) {
      console.error(`RazorpayX API error: ${response.status}`);
      return null;
    }

    const payout = await response.json();
    return {
      status: payout.status,
      failureReason: payout.failure_reason,
    };
  } catch (error) {
    console.error(`Failed to get RazorpayX payout status: ${error}`);
    return null;
  }
}

/**
 * Map gateway payout status to our PayoutStatus
 */
function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PayoutStatus | null {
  if (gateway === PaymentGateway.STRIPE) {
    switch (status.toLowerCase()) {
      case "paid":
        return PayoutStatus.COMPLETED;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "in_transit":
        return PayoutStatus.PROCESSING;
      case "canceled":
        return PayoutStatus.CANCELLED;
      case "failed":
        return PayoutStatus.FAILED;
      case "reversed":
        return PayoutStatus.FAILED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
    switch (status.toLowerCase()) {
      case "processed":
        return PayoutStatus.COMPLETED;
      case "processing":
        return PayoutStatus.PROCESSING;
      case "queued":
        return PayoutStatus.PROCESSING;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "rejected":
        return PayoutStatus.FAILED;
      case "reversed":
        return PayoutStatus.FAILED;
      case "cancelled":
        return PayoutStatus.CANCELLED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Find and handle stuck payouts
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function handleStuckPayouts(): Promise<StuckPayoutsResult> {
  return withCronLock("handle-stuck-payouts", { failMode: "closed", ttlMs: LONG_JOB_TTL_MS }, () =>
    handleStuckPayoutsUnlocked(),
  );
}

async function handleStuckPayoutsUnlocked(): Promise<StuckPayoutsResult> {
  const errors: string[] = [];
  let reconciledCount = 0;
  let retriedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

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

  const razorpayConfigured = !!(process.env.RAZORPAY_KEY_ID &&
    (process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET));
  if (!razorpayConfigured) {
    console.warn("⚠️ Razorpay credentials not configured — Razorpay records will be skipped");
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
        await prisma.consultantPayout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.FAILED,
            failureReason:
              "Payout never sent to gateway after multiple attempts",
          },
        });
        failedCount++;
        console.log(`   Marked as permanently FAILED (max retries reached)`);
      } else {
        // Reset to APPROVED for retry
        await prisma.consultantPayout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.APPROVED,
            retryCount: { increment: 1 },
          },
        });
        retriedCount++;
        console.log(
          `   Reset to APPROVED for retry (attempt ${payout.retryCount + 1})`,
        );
      }
      continue;
    }

    // Query gateway for actual status
    let gatewayStatus: {
      status: string;
      failureMessage?: string;
      failureReason?: string;
    } | null = null;

    if (payout.provider === PaymentGateway.STRIPE) {
      gatewayStatus = await getStripePayoutStatus(payout.providerPayoutId);
    } else if (payout.provider === PaymentGateway.RAZORPAY) {
      if (!razorpayConfigured) {
        console.log(`   Skipping - Razorpay credentials not configured`);
        skippedCount++;
        continue;
      }
      gatewayStatus = await getRazorpayPayoutStatus(payout.providerPayoutId);
    }

    if (!gatewayStatus) {
      console.log(`   Could not get status from gateway - skipping`);
      errors.push(`Payout ${payout.id}: Could not query gateway status`);
      continue;
    }

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
      await prisma.consultantPayout.update({
        where: { id: payout.id },
        data: {
          status: mappedStatus,
          failureReason:
            mappedStatus === PayoutStatus.FAILED
              ? gatewayStatus.failureMessage || gatewayStatus.failureReason
              : undefined,
          processedAt:
            mappedStatus === PayoutStatus.COMPLETED ? new Date() : undefined,
        },
      });

      console.log(`   Updated status: ${payout.status} → ${mappedStatus}`);
      reconciledCount++;

      // Update earnings if completed
      if (mappedStatus === PayoutStatus.COMPLETED) {
        await prisma.consultantEarnings.updateMany({
          where: { payoutId: payout.id },
          data: { status: "PAID" },
        });
        console.log(`   Updated linked earnings to PAID`);
      }
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

  return {
    success: errors.length === 0,
    totalProcessed: stuckPayouts.length,
    reconciledCount,
    retriedCount,
    failedCount,
    skippedCount,
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
