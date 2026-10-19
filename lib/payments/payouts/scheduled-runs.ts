import { PayoutStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { PAYOUT_CONSTANTS } from "./constants";
import {
  createPayoutBatchSlice,
  processApprovedPayouts,
  REQUEST_PAYOUT_RUN_BOUNDS,
} from "./payout-service";
import {
  createOrgPayoutBatches,
  processPendingOrgPayouts,
  type OrgBatchResult,
} from "./org-payout-service";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatePayoutBatchesRun {
  success: boolean;
  batchId: string;
  consultantPayoutsMinted: number;
  org: OrgBatchResult;
  failed: number;
  remaining: number;
}

/**
 * The scheduled consultant and org batch, `limit` units per rail. The org
 * period ends at `windowStart` so every slice of one window reuses the same
 * period and idempotency key; a manual run without it ends the period now.
 */
export async function runCreatePayoutBatches(opts: {
  limit: number;
  windowStart?: Date;
}): Promise<CreatePayoutBatchesRun> {
  return withCronLock(
    "create-payout-batch",
    { failMode: "closed" },
    async () => {
      const consultant = await createPayoutBatchSlice(opts);
      const periodEnd = opts.windowStart ?? new Date();
      const org = await createOrgPayoutBatches({
        periodStart: new Date(periodEnd.getTime() - WEEK_MS),
        periodEnd,
        limit: opts.limit,
      });
      return {
        success: true,
        batchId: consultant.batchId,
        consultantPayoutsMinted: consultant.minted,
        org,
        failed: org.failed,
        remaining: consultant.remaining + org.remaining,
      };
    },
  );
}

/**
 * The service returns [] both when ENABLE_LIVE_PAYOUTS is off (the freeze
 * parks APPROVED rows by design) and when the Redis lock is held; only the
 * latter is a fault.
 */
export function classifyEmptyRun(input: {
  waiting: number;
  livePayoutsEnabled: boolean;
}):
  | { kind: "ok" }
  | { kind: "parked"; notice: string }
  | { kind: "failed"; error: string } {
  if (input.waiting === 0) return { kind: "ok" };
  if (!input.livePayoutsEnabled) {
    return {
      kind: "parked",
      notice: `live payouts disabled (ENABLE_LIVE_PAYOUTS); ${input.waiting} APPROVED payout(s) parked by design`,
    };
  }
  return {
    kind: "failed",
    error: `${input.waiting} APPROVED payouts waiting; processing lock unavailable`,
  };
}

export interface ProcessPayoutsRun {
  success: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  orgAdvanced: number;
  orgErrors: number;
  notice: string | null;
  errors: string[];
}

/**
 * The scheduled disbursement run, consultant then org, `limit` units per rail.
 * `success` is false only when APPROVED rows wait behind an unavailable lock;
 * row failures are counted in `failed` and `orgErrors`.
 */
export async function runProcessPayouts(opts: {
  limit: number;
}): Promise<ProcessPayoutsRun> {
  return withCronLock("process-payouts", { failMode: "closed" }, async () => {
    const results = await processApprovedPayouts({
      ...REQUEST_PAYOUT_RUN_BOUNDS,
      limit: opts.limit,
    });
    // A row claimed by a concurrent run belongs to that run.
    const counted = results.filter((r) => !r.skipped);
    const succeeded = counted.filter((r) => r.success).length;
    const errors = counted
      .filter((r) => !r.success && r.error)
      .map((r) => `Payout ${r.payoutId}: ${r.error}`);

    let notice: string | null = null;
    let lockFault = false;
    if (results.length === 0) {
      const waiting = await prisma.consultantPayout.count({
        where: {
          status: PayoutStatus.APPROVED,
          retryCount: { lt: PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS },
        },
      });
      const verdict = classifyEmptyRun({
        waiting,
        livePayoutsEnabled: ENABLE_LIVE_PAYOUTS,
      });
      if (verdict.kind === "parked") notice = verdict.notice;
      if (verdict.kind === "failed") {
        lockFault = true;
        errors.push(verdict.error);
      }
    }

    const org = await processPendingOrgPayouts({ limit: opts.limit });
    errors.push(...org.errors);

    return {
      success: !lockFault,
      processed: counted.length,
      succeeded,
      failed: counted.length - succeeded,
      orgAdvanced: org.advanced,
      orgErrors: org.errors.length,
      notice,
      errors,
    };
  });
}
