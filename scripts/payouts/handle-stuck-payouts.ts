/**
 * Stuck Payouts Handler - Core Logic
 *
 * Handles payouts stuck in PROCESSING status for too long.
 * Queries payment gateways to get actual status and updates DB.
 * Retries a payout the gateway never received up to
 * PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS attempts, then fails it.
 *
 * This catches cases where:
 * - Payout webhook was missed or delayed
 * - Gateway processed but DB update failed
 * - Network timeout during payout processing
 *
 * Driven by the `/api/cleanup/handle-stuck-payouts` twin with a per-model
 * `limit` and the request's `startedAt`; each cohort rotates on
 * `lastReconciledAt` (see reconcile-cursor.ts).
 */

import prisma, { type PrismaLike } from "../../lib/prisma";
import {
  PayoutStatus,
  PaymentGateway,
  EarningStatus,
  type Prisma,
} from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import {
  recordSystemError,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import {
  applyOrgGatewayStatus,
  handlePayoutWebhook,
  markOrgPayoutFailed,
} from "@/lib/payments/payouts";
import { resolveRazorpayXCredentials } from "@/lib/payments/payouts/razorpay-payouts";
import { releaseClawbackRecovery } from "@/lib/payments/payouts/clawback-recovery";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import {
  type PayoutLookup,
  WEBHOOK_STATUS_MAP,
  getRazorpayPayoutStatus,
  findRazorpayPayoutByReference,
  mapGatewayStatus,
  retireUnknownGatewayPayout,
} from "@/lib/payments/payouts/payout-gateway-lookup";
import {
  DEFAULT_RECONCILE_LIMIT,
  LEAST_RECENTLY_RECONCILED,
  pollInRotation,
  stampConsultantPayoutsReconciled,
  stampOrgPayoutsReconciled,
} from "@/lib/payments/payouts/reconcile-cursor";
import { startDeadline } from "@/lib/cron/run-deadline";
import { reportSentryMessage } from "@/lib/observability/report";
import { createRunFailureReporter } from "@/lib/observability/run-failures";

// Consider payouts stuck if in PROCESSING for more than 24 hours
const STUCK_THRESHOLD_HOURS = 24;

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

/** PROCESSING past the stuck threshold; the same predicate on both payout tables. */
function stuckPayoutWhere(stuckThreshold: Date) {
  return {
    status: PayoutStatus.PROCESSING,
    updatedAt: { lt: stuckThreshold },
  } satisfies Prisma.ConsultantPayoutWhereInput &
    Prisma.OrganizationPayoutWhereInput;
}

/** True when either payout table holds a stuck PROCESSING row. */
export async function hasStuckPayoutWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const stuckThreshold = new Date(
    now.getTime() - STUCK_THRESHOLD_HOURS * 60 * 60 * 1000,
  );
  if (outOfTime()) return true;
  const consultant = await db.consultantPayout.findFirst({
    where: stuckPayoutWhere(stuckThreshold),
    select: { id: true },
  });
  if (consultant) return true;
  if (outOfTime()) return true;
  const org = await db.organizationPayout.findFirst({
    where: stuckPayoutWhere(stuckThreshold),
    select: { id: true },
  });
  return org !== null;
}

/**
 * Find and handle stuck payouts
 */
// Fail-closed: money state must not double-run unlocked. A permanent failure or
// a crash also lands in SystemEvent, because it means someone is not being paid.
export async function handleStuckPayouts(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<StuckPayoutsResult> {
  const limit = opts.limit ?? DEFAULT_RECONCILE_LIMIT;
  const pastDeadline = startDeadline(opts.startedAt);
  return withCronLock(
    "handle-stuck-payouts",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    async () => {
      try {
        const result = await handleStuckPayoutsUnlocked(limit, pastDeadline);
        if (result.failedCount > 0 || !result.success) {
          await recordSystemEvent({
            category: "PAYOUT",
            severity: "ERROR",
            message: `Stuck-payout handler: ${result.failedCount} permanently failed, success=${result.success}`,
            context: {
              totalProcessed: result.totalProcessed,
              failedCount: result.failedCount,
              retriedCount: result.retriedCount,
              errors: result.errors,
            },
          });
        }
        return result;
      } catch (error) {
        await recordSystemError({
          category: "PAYOUT",
          summary: "Stuck-payout handler crashed",
          err: error,
        });
        throw error;
      }
    },
  );
}

async function handleStuckPayoutsUnlocked(
  limit: number,
  pastDeadline: () => boolean,
): Promise<StuckPayoutsResult> {
  const errors: string[] = [];
  let reconciledCount = 0;
  let retriedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let retiredCount = 0;
  const retired: string[] = [];
  const failures = createRunFailureReporter("payments");

  const stuckThreshold = new Date(
    Date.now() - STUCK_THRESHOLD_HOURS * 60 * 60 * 1000,
  );

  // Find payouts stuck in PROCESSING for too long
  const stuckPayouts = await prisma.consultantPayout.findMany({
    where: stuckPayoutWhere(stuckThreshold),
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: [LEAST_RECENTLY_RECONCILED, { updatedAt: "asc" }],
    take: limit,
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

  const consultantStarted = await pollInRotation(
    stuckPayouts,
    stampConsultantPayoutsReconciled,
    pastDeadline,
    (payout, err) =>
      errors.push(
        `Payout ${payout.id}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    async (payout) => {
      console.log(
        `\nProcessing stuck payout ${payout.id} for ${payout.consultantProfile.user.name || "Unknown"}`,
      );
      console.log(
        `   Amount: ${payout.currency} ${(payout.amount / 100).toFixed(2)}`,
      );
      console.log(`   Provider: ${payout.provider}`);
      console.log(
        `   Provider Payout ID: ${payout.providerPayoutId || "none"}`,
      );
      console.log(`   Last updated: ${payout.updatedAt.toISOString()}`);
      console.log(`   Retry count: ${payout.retryCount}`);

      let providerPayoutId = payout.providerPayoutId;
      if (!providerPayoutId) {
        // #1846 N1 — no provider id does NOT mean "never sent": a submit whose
        // reply timed out leaves exactly this row, and the transfer may exist.
        // Ask the gateway by reference id (our row id) before resubmitting or
        // failing. Only "none" makes either safe; a found payout is stamped and
        // settled below like any other.
        if (payout.provider !== PaymentGateway.RAZORPAY) {
          // Only RazorpayX has a reference lookup; resubmitting any other
          // provider's payout could pay twice, so an operator settles these.
          skippedCount++;
          errors.push(
            `Payout ${payout.id}: ${payout.provider} payout with no provider id needs manual review`,
          );
          return;
        }
        if (!razorpayConfigured) {
          console.log(`   Skipping - Razorpay credentials not configured`);
          skippedCount++;
          return;
        }
        const ref = await findRazorpayPayoutByReference(payout.id);
        if (ref.kind === "gateway_error" || ref.kind === "ambiguous") {
          errors.push(
            `Payout ${payout.id}: reference lookup ${ref.kind} (${ref.detail})`,
          );
          if (ref.kind === "ambiguous") {
            failures.add(
              "handle-stuck-payouts.ambiguous-reference",
              new Error(
                "handle-stuck-payouts: several gateway payouts share one reference",
              ),
              { payoutId: payout.id, detail: ref.detail },
              { level: "error" },
            );
          }
          return;
        }
        if (ref.kind === "found") {
          await prisma.consultantPayout.updateMany({
            where: { id: payout.id, providerPayoutId: null },
            data: { providerPayoutId: ref.providerPayoutId },
          });
          console.log(
            `   Gateway holds ${ref.providerPayoutId} for this reference - settling it`,
          );
          providerPayoutId = ref.providerPayoutId;
        }
      }

      if (!providerPayoutId) {
        console.log(`   Gateway holds no payout for this reference`);

        // A re-arm that would reach the ceiling fails instead, so the disbursement run never strands it APPROVED.
        if (payout.retryCount + 1 >= PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS) {
          // #1205-triage — CAS the terminal flip inside the same tx as the
          // earnings release: without the PROCESSING guard, a concurrently
          // completing gateway webhook could be overwritten by this FAILED.
          const cas = await prisma.$transaction(async (tx) => {
            // Only the confirmed "none" releases earnings: a gateway id bound meanwhile means a payout exists.
            const claimed = await tx.consultantPayout.updateMany({
              where: {
                id: payout.id,
                status: PayoutStatus.PROCESSING,
                providerPayoutId: null,
              },
              data: {
                status: PayoutStatus.FAILED,
                failureReason:
                  "Payout never sent to gateway after multiple attempts",
                // The TDS outcome is staged before submission (#1846 N1); a
                // payout that never left withheld nothing.
                tdsDeducted: 0,
                netAmount: null,
                tdsRateAppliedBps: null,
                tdsFinancialYear: null,
                tdsCatchUpFy: null,
                tdsCarryPaise: 0,
                tdsCreditPaise: 0,
              },
            });
            if (claimed.count === 0) return { released: 0, claimed: false };
            const released = await tx.consultantEarnings.updateMany({
              where: { payoutId: payout.id, status: EarningStatus.BATCHED },
              data: {
                payoutId: null,
                status: EarningStatus.READY,
                releasedFromPayoutId: payout.id,
              },
            });
            await releaseClawbackRecovery(tx, payout.id);
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
        return;
      }

      // Query gateway for actual status
      let lookup: PayoutLookup | null = null;

      if (payout.provider === PaymentGateway.RAZORPAY) {
        if (!razorpayConfigured) {
          console.log(`   Skipping - Razorpay credentials not configured`);
          skippedCount++;
          return;
        }
        lookup = await getRazorpayPayoutStatus(providerPayoutId);
      }

      // #1757 — an id the gateway has no record of is terminal for this row, not
      // a run failure: FAILED via the canonical handler (releases earnings, TDS).
      if (lookup?.kind === "unknown_id") {
        await retireUnknownGatewayPayout(
          {
            provider: payout.provider,
            providerPayoutId,
          },
          lookup.detail,
        );
        retiredCount++;
        retired.push(payout.id);
        return;
      }

      if (!lookup || lookup.kind === "gateway_error") {
        console.log(`   Could not get status from gateway - skipping`);
        const detailSuffix = lookup ? ` (${lookup.detail})` : "";
        errors.push(
          `Payout ${payout.id}: Could not query gateway status${detailSuffix}`,
        );
        return;
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
        return;
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
          return;
        }

        await handlePayoutWebhook(
          payout.provider,
          providerPayoutId,
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
    },
  );

  const org = await handleStuckOrgPayouts(
    stuckThreshold,
    razorpayConfigured,
    limit,
    pastDeadline,
  );
  reconciledCount += org.reconciled;
  retriedCount += org.retried;
  skippedCount += org.skipped;
  retiredCount += org.retired.length;
  retired.push(...org.retired);
  errors.push(...org.errors);
  const totalProcessed = consultantStarted + org.processed;

  // Summary
  console.log("\n📊 Stuck Payouts Summary:");
  console.log(`   Total processed: ${totalProcessed}`);
  console.log(`   Reconciled: ${reconciledCount}`);
  console.log(`   Reset for retry: ${retriedCount}`);
  console.log(`   Permanently failed: ${failedCount}`);
  console.log(`   Skipped: ${skippedCount}`);

  console.log(`   Retired (gateway does not know the id): ${retiredCount}`);

  failures.flush();

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
    totalProcessed,
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

interface StuckOrgPayoutsRun {
  processed: number;
  reconciled: number;
  retried: number;
  skipped: number;
  retired: string[];
  errors: string[];
}

/**
 * The same rules for OrganizationPayout: a row with no gateway id is looked up
 * by reference id, and only a confirmed "gateway has none" re-arms it APPROVED,
 * so the next run re-checks holds, disputes and the account before resending.
 */
async function handleStuckOrgPayouts(
  stuckThreshold: Date,
  razorpayConfigured: boolean,
  limit: number,
  pastDeadline: () => boolean,
): Promise<StuckOrgPayoutsRun> {
  const run: StuckOrgPayoutsRun = {
    processed: 0,
    reconciled: 0,
    retried: 0,
    skipped: 0,
    retired: [],
    errors: [],
  };
  const stuck = await prisma.organizationPayout.findMany({
    where: stuckPayoutWhere(stuckThreshold),
    select: { id: true, gatewayPayoutId: true },
    orderBy: [LEAST_RECENTLY_RECONCILED, { updatedAt: "asc" }],
    take: limit,
  });
  if (stuck.length > 0 && !razorpayConfigured) {
    run.processed = stuck.length;
    run.skipped += stuck.length;
    return run;
  }

  // One row's failure is recorded and never blocks the rows behind it.
  run.processed = await pollInRotation(
    stuck,
    stampOrgPayoutsReconciled,
    pastDeadline,
    (payout, err) =>
      run.errors.push(
        `OrgPayout ${payout.id}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    async (payout) => {
      try {
        await reconcileStuckOrgPayout(payout, run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.errors.push(`OrgPayout ${payout.id}: ${message}`);
      }
    },
  );
  return run;
}

async function reconcileStuckOrgPayout(
  payout: { id: string; gatewayPayoutId: string | null },
  run: StuckOrgPayoutsRun,
): Promise<void> {
  let gatewayPayoutId = payout.gatewayPayoutId;
  if (!gatewayPayoutId) {
    const ref = await findRazorpayPayoutByReference(payout.id);
    if (ref.kind === "gateway_error" || ref.kind === "ambiguous") {
      run.errors.push(
        `OrgPayout ${payout.id}: reference lookup ${ref.kind} (${ref.detail})`,
      );
      return;
    }
    if (ref.kind === "none") {
      const reset = await prisma.organizationPayout.updateMany({
        where: {
          id: payout.id,
          status: PayoutStatus.PROCESSING,
          gatewayPayoutId: null,
        },
        data: { status: PayoutStatus.APPROVED },
      });
      if (reset.count === 0) run.skipped++;
      else run.retried++;
      return;
    }
    await prisma.organizationPayout.updateMany({
      where: { id: payout.id, gatewayPayoutId: null },
      data: { gatewayPayoutId: ref.providerPayoutId },
    });
    gatewayPayoutId = ref.providerPayoutId;
  }

  const lookup = await getRazorpayPayoutStatus(gatewayPayoutId);
  if (lookup.kind === "unknown_id") {
    await markOrgPayoutFailed(payout.id, "GATEWAY_UNKNOWN_ID");
    run.retired.push(payout.id);
    return;
  }
  if (lookup.kind === "gateway_error") {
    run.errors.push(
      `OrgPayout ${payout.id}: Could not query gateway status (${lookup.detail})`,
    );
    return;
  }
  const moved = await applyOrgGatewayStatus(payout.id, {
    status: lookup.status,
    utr: lookup.utr,
    failureReason: lookup.failureMessage || lookup.failureReason,
  });
  if (moved) run.reconciled++;
}
