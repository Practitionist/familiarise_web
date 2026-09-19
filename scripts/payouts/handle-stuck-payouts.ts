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
import { reportSentryMessage } from "@/lib/observability/report";

// #1757 — `unknown_id` (the gateway has no record of the id; terminal per row)
// is kept apart from `gateway_error` (unreachable, down, bad auth; retried).
type PayoutLookup =
  | {
      kind: "status";
      status: string;
      failureMessage?: string;
      failureReason?: string;
      utr?: string;
    }
  | { kind: "unknown_id"; detail: string }
  | { kind: "gateway_error"; detail: string };

/** Stripe answers `resource_missing` / 404 for a payout or transfer id it never issued. */
function isStripeUnknownId(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

/** Razorpay's error body is `{ error: { code, description } }`; tolerate anything else. */
async function razorpayErrorDescription(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; description?: unknown };
    };
    return [body?.error?.code, body?.error?.description]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  } catch {
    return "";
  }
}

// PM-15 — narrow PayoutStatus to the status union handlePayoutWebhook accepts.
// mapGatewayStatus only ever returns these four, so the rest map to undefined
// (treated as "no canonical transition" at the call site).
const WEBHOOK_STATUS_MAP: Partial<
  Record<
    PayoutStatus,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  >
> = {
  [PayoutStatus.COMPLETED]: "COMPLETED",
  [PayoutStatus.PROCESSING]: "PROCESSING",
  [PayoutStatus.FAILED]: "FAILED",
  [PayoutStatus.CANCELLED]: "CANCELLED",
};

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
 * Query Stripe for payout/transfer status
 */
async function getStripePayoutStatus(
  providerPayoutId: string,
): Promise<PayoutLookup> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return {
      kind: "gateway_error",
      detail: "Stripe credentials not configured",
    };
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Check if it's a transfer (tr_) or payout (po_)
    if (providerPayoutId.startsWith("tr_")) {
      const transfer = await stripe.transfers.retrieve(providerPayoutId);
      return {
        kind: "status",
        status: transfer.reversed ? "reversed" : "paid",
      };
    } else if (providerPayoutId.startsWith("po_")) {
      const payout = await stripe.payouts.retrieve(providerPayoutId);
      return {
        kind: "status",
        status: payout.status,
        failureMessage: payout.failure_message || undefined,
      };
    }

    return { kind: "gateway_error", detail: "unrecognised Stripe id prefix" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isStripeUnknownId(error)) return { kind: "unknown_id", detail };
    console.error(`Failed to get Stripe payout status: ${error}`);
    return { kind: "gateway_error", detail };
  }
}

/**
 * Query RazorpayX for payout status
 */
async function getRazorpayPayoutStatus(
  providerPayoutId: string,
): Promise<PayoutLookup> {
  // #1407 — the same resolver the disbursement path uses. Reading
  // RAZORPAY_KEY_ID/RAZORPAY_SECRET here authenticated as the checkout
  // merchant, not the RazorpayX one, so on an account with distinct X keys
  // every lookup 401s and this reconciliation is silently dead while it
  // looks green. (#677 PM-1 kept the RAZORPAY_SECRET fallback, inside the
  // resolver now.)
  const { keyId, keySecret } = resolveRazorpayXCredentials();

  if (!keyId || !keySecret) {
    console.warn("RazorpayX credentials not configured");
    return {
      kind: "gateway_error",
      detail: "RazorpayX credentials not configured",
    };
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
      // RazorpayX answers 400 BAD_REQUEST_ERROR ("does not exist"), not 404,
      // for an id it never issued; 401/403 is our key, anything else is theirs.
      const { status } = response;
      const description = await razorpayErrorDescription(response);
      if (status === 400 || status === 404) {
        return { kind: "unknown_id", detail: `${status} ${description}` };
      }
      console.error(`RazorpayX API error: ${status} ${description}`);
      return { kind: "gateway_error", detail: `${status} ${description}` };
    }

    const payout = await response.json();
    return {
      kind: "status",
      status: payout.status,
      failureReason: payout.failure_reason,
      // PM-15 — RazorpayX returns the bank UTR on a processed payout; capture
      // it so the COMPLETED path can persist the canonical reference.
      utr: payout.utr,
    };
  } catch (error) {
    console.error(`Failed to get RazorpayX payout status: ${error}`);
    return {
      kind: "gateway_error",
      detail: error instanceof Error ? error.message : String(error),
    };
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
      // #1407 — RazorpayX returns `failed` for a payout the bank refused after
      // it was queued, and the arm had only `rejected`. A failed payout fell
      // through to "unknown gateway status" and was skipped, so its earnings
      // stayed linked to a payout that will never pay while the row sat in
      // PROCESSING forever. The Stripe arm has always mapped it.
      case "failed":
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
      console.warn(
        `   Gateway does not know ${payout.providerPayoutId} (${lookup.detail}) - retiring as FAILED/GATEWAY_UNKNOWN_ID`,
      );
      await handlePayoutWebhook(
        payout.provider,
        payout.providerPayoutId,
        "FAILED",
        "GATEWAY_UNKNOWN_ID",
      );
      retiredCount++;
      retired.push(payout.id);
      continue;
    }

    if (!lookup || lookup.kind === "gateway_error") {
      console.log(`   Could not get status from gateway - skipping`);
      errors.push(
        `Payout ${payout.id}: Could not query gateway status${lookup ? ` (${lookup.detail})` : ""}`,
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
