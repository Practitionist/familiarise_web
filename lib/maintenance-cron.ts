/**
 * Maintenance Mode Guard — Cron Job Utility
 *
 * All cron job scripts should call abortIfMaintenance() at entry.
 * This prevents jobs from reading/writing to the database during
 * OFFLINE maintenance (when DB may be mid-migration) and prevents
 * financial jobs from running during DEGRADED maintenance.
 *
 * Fail-open design: if Redis is unreachable, the job proceeds normally.
 * This matches the fail-open design of the rest of the maintenance system.
 *
 * Usage in each job script:
 *   import { abortIfMaintenance } from "@/lib/maintenance-cron";
 *   await abortIfMaintenance("cleanup-abandoned-payments");
 */

import { Redis } from "@upstash/redis";

// Financial jobs that must NOT run even in DEGRADED mode.
// These jobs call external APIs to create/cancel financial objects,
// or mutate financial state (earnings, payouts, refunds) that could
// become inconsistent during a partial deployment.
const FINANCIAL_JOB_NAMES = new Set([
  "process-payouts",
  "create-payout-batch",
  "handle-stuck-payouts",
  "reconcile-payout-status",
  "cascade-refund-earnings",
  "reconcile-pending-refunds",
  "handle-lost-disputes",
  "reconcile-disputes",
  "cleanup-abandoned-payments",
  "release-earnings",
  "reconcile-payment-status",
  "sync-payment-earnings",
]);

/**
 * Check maintenance state and exit cleanly if the job should not run.
 *
 * OFFLINE  → always exits (process.exit(0)) — DB may be mid-migration
 * DEGRADED → exits for financial jobs only — protects payment integrity
 * OFF      → continues normally
 *
 * @param jobName - Human-readable job name used in logs. Should match the
 *   file name (e.g. "cleanup-abandoned-payments" for
 *   jobs/payments/cleanup-abandoned-payments.ts). Financial job names must
 *   match exactly the entries in FINANCIAL_JOB_NAMES above.
 */
export async function abortIfMaintenance(jobName: string): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // No Redis configured — fail-open
    console.warn(
      `[${jobName}] UPSTASH_REDIS env vars not set — skipping maintenance check, proceeding`,
    );
    return;
  }

  try {
    // Intentionally creates a fresh client per invocation — cron jobs run
    // infrequently and this avoids holding a persistent connection.
    const redis = new Redis({ url, token });
    const phase = await redis.get<string>("maintenance:phase");

    if (phase === "OFFLINE") {
      console.log(
        `[${jobName}] Maintenance mode is OFFLINE — skipping job to protect DB during migration`,
      );
      process.exit(0);
    }

    if (phase === "DEGRADED" && FINANCIAL_JOB_NAMES.has(jobName)) {
      console.log(
        `[${jobName}] Maintenance mode is DEGRADED — skipping financial job to protect payment integrity`,
      );
      process.exit(0);
    }

    if (phase === "DEGRADED") {
      console.log(
        `[${jobName}] Maintenance mode is DEGRADED — proceeding (non-financial job)`,
      );
    }
  } catch (error) {
    // Fail-open: if Redis is unreachable, proceed with the job
    console.warn(
      `[${jobName}] Could not check maintenance state (Redis error: ${
        error instanceof Error ? error.message : String(error)
      }) — proceeding`,
    );
  }
}
