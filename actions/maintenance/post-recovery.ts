/**
 * Post-Recovery Automation — called when ending maintenance mode.
 *
 * Verifies critical systems are operational:
 * - Database connectivity
 * - Redis connectivity
 * - Sends "we're back" broadcast notification
 * - Returns the statutory follow-ups (GST register, IRP, TDS draft, full reconcile)
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { checkRedisHealth } from "@/lib/redis";
import { restoreDiscountCodes } from "@/actions/maintenance/pause-discount-codes";

interface RecoveryResult {
  database: boolean;
  redis: boolean;
  reconciliation?: { job: string; success: boolean }[];
  /** Statutory steps an operator runs by hand once the platform is back. */
  statutoryFollowUps?: string[];
  errors: string[];
}

/**
 * The statutory tail of a recovery. Each step writes filings or numbers a
 * gapless series, so an operator runs it deliberately rather than firing it here.
 */
const STATUTORY_FOLLOW_UPS = [
  "Run gst-outward-register-export and check its warnings before the 11th-of-month GSTR-1 filing.",
  "Re-run the irp-uploader workflow so B2B invoices issued during the outage get their IRN inside the 30-day window.",
  "Run tds-return-draft again so the quarter's TDS return draft includes payouts settled during the outage.",
  "Run reconcile-ledgers with full scope and clear every finding before reopening payouts.",
];

export async function runPostRecovery(): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    database: false,
    redis: false,
    statutoryFollowUps: [...STATUTORY_FOLLOW_UPS],
    errors: [],
  };

  // 1. Verify DB connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.database = true;
  } catch (error) {
    Sentry.logger.warn("Post-recovery DB health check failed", {
      tags: { subsystem: "maintenance" },
    });
    result.errors.push(
      `Database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. Check Redis health (independent of DB, runs in parallel with DB-dependent steps)
  const redisCheckPromise = (async () => {
    try {
      result.redis = await checkRedisHealth();
      if (!result.redis) {
        result.errors.push("Redis: PING failed");
      }
    } catch (error) {
      Sentry.logger.warn("Post-recovery Redis health check failed", {
        tags: { subsystem: "maintenance" },
      });
      result.errors.push(
        `Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  // 3. Restore discount codes that were paused before maintenance
  if (result.database) {
    try {
      const discountResult = await restoreDiscountCodes();
      console.log(
        JSON.stringify({
          event: "maintenance_discount_codes_restored_in_recovery",
          ...discountResult,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "maintenance" } },
      );
      result.errors.push(
        `Discount restore: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 5. Ensure Redis check completes before proceeding
  await redisCheckPromise;

  console.log(
    JSON.stringify({
      event: "maintenance_post_recovery",
      result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}
