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
 *
 * Usage in the HTTP twins under app/api/cleanup/** , which run inside the Next
 * server and therefore cannot call process.exit:
 *   import { assertNotInMaintenance } from "@/lib/maintenance-cron";
 *   await assertNotInMaintenance("cleanup-abandoned-payments"); // throws 503
 */

import redis from "@/lib/redis";
import { flushJobSentry } from "@/lib/observability/job-sentry";
import { captureThrottled } from "@/lib/observability/throttled-capture";

// Financial jobs that must NOT run even in DEGRADED mode.
// These jobs call external APIs to create/cancel financial objects,
// or mutate financial state (earnings, payouts, refunds) that could
// become inconsistent during a partial deployment.
// Exported for the lock-registry drift test (#1169): every member that is
// cron-scheduled must hold a fail-closed lock.
// #1582/#1598 — `sweep-stuck-webhook-events`, `reconcile-orphaned-confirmations`
// and `sweep-orphaned-topup-captures` DO move money, but only by re-driving a
// webhook DEGRADED already exempts, so they are deliberately not listed here.
export const FINANCIAL_JOB_NAMES = new Set([
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
  "generate-subscription-invoices",
  "settle-invoice-accruals",
  // #1506 — cancels and refunds consultant no-shows through
  // refundBookingPayment; every job that calls the refund front door belongs
  // here so DEGRADED maintenance holds it with the other refunding jobs.
  "detect-consultant-no-shows",
  // #1506 — expirePaymentPendingRequests/expireApprovedUnallocatedSubscriptions
  // in this job call refundPaymentsForExpired, another refund front-door
  // caller that must be held with the rest of the money jobs.
  "expire-stale-requests",
  // Added by the wave-5 sweep: each of these either moves money directly or
  // mutates the org contract/program state the checkout sponsorship resolver
  // reads, so a partial deployment can bill against a half-written entitlement.
  "release-pending-trust-earnings",
  "auto-renew-contracts",
  "dunning",
  "timeout-member-overages",
  "advance-program-cycles",
  "expire-contracts",
  // Registers IRNs with the government portal and writes the resulting IRP
  // state onto the invoice. It moves no money, but a half-deployed payload
  // becomes a statutory record that can only be cancelled for 24 hours.
  "irp-uploader",
  // #1370 — its healer mints tax invoices, which burns numbers from a gapless
  // statutory series. A half-deployed run leaves gaps that cannot be filled.
  "gst-outward-register-export",
]);

/**
 * #1599 F-P1-03 — the admin console (`/api/admin/system-jobs/run`) keys a few
 * jobs by an id spelled differently from the cron job name. Map those here so
 * the DEGRADED gate has one list, `FINANCIAL_JOB_NAMES`, and no second copy.
 */
const CRON_JOB_NAME_BY_ADMIN_ID: Record<string, string> = {
  "reconcile-refunds": "reconcile-pending-refunds",
  // Rides inside the abandoned-payments run since #1321.
  "cleanup-approval-payments": "cleanup-abandoned-payments",
  "tentative-occurrences": "cleanup-tentative-occurrences",
  "auth-tokens": "cleanup-auth-tokens",
};

/** True when a cron job name, or an admin console job id, is a money job. */
export function isFinancialJob(jobIdOrName: string): boolean {
  return FINANCIAL_JOB_NAMES.has(
    CRON_JOB_NAME_BY_ADMIN_ID[jobIdOrName] ?? jobIdOrName,
  );
}

/** The maintenance phases that can stop a job. */
export type BlockingMaintenancePhase = "OFFLINE" | "DEGRADED";

/**
 * Thrown by {@link assertNotInMaintenance} in place of the `process.exit(0)`
 * a long-lived server process must never take. Carries the status the HTTP
 * layer should answer with so every call site maps it the same way.
 */
export class MaintenanceActiveError extends Error {
  readonly httpStatus = 503;
  readonly phase: BlockingMaintenancePhase;
  readonly jobName: string;

  constructor(jobName: string, phase: BlockingMaintenancePhase) {
    super(
      phase === "OFFLINE"
        ? `Maintenance mode is OFFLINE — ${jobName} is unavailable while the database may be mid-migration`
        : `Maintenance mode is DEGRADED — ${jobName} is a financial job and is unavailable until maintenance ends`,
    );
    this.name = "MaintenanceActiveError";
    this.jobName = jobName;
    this.phase = phase;
  }
}

// #1822 Q-5 — a tick's many target invocations each used to mint a fresh
// `new Redis({url, token})` and pay its own GET. Cache the phase for the life
// of the process (capped at 60s) so they share one Redis command; a stale
// positive can only delay a maintenance transition being honoured by up to
// that window, which the fail-open design already tolerates.
const PHASE_CACHE_MS = 60_000;
let phaseCachedAt = 0;
let phaseCachedValue: string | null = null;
let phaseCacheHasValue = false;

/**
 * Read `maintenance:phase` from Redis. Returns null when the phase cannot be
 * established — no Redis configured, or the probe failed — which every caller
 * treats as "proceed", matching the fail-open design of the rest of the system.
 */
async function readMaintenancePhase(jobName: string): Promise<string | null> {
  const now = Date.now();
  if (phaseCacheHasValue && now - phaseCachedAt < PHASE_CACHE_MS) {
    return phaseCachedValue;
  }

  try {
    // Shared node client (#1822 Q-5) — cron jobs used to mint a fresh client
    // per invocation; that's the same GET, paid again for no reason.
    const phase = await redis.get<string>("maintenance:phase");
    phaseCachedValue = phase;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    return phase;
  } catch (error) {
    // Fail-open: if Redis is unreachable, proceed with the job. Cache the
    // fail-open null too, so a sustained outage doesn't retry Redis on every
    // job in the fleet within the same window.
    console.warn(
      `[${jobName}] Could not check maintenance state (Redis error: ${
        error instanceof Error ? error.message : String(error)
      }) — proceeding`,
    );
    phaseCachedValue = null;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    // #1822 Q-1 — this used to be an unconditional captureException, which is
    // what turned one Upstash outage into ~2,650 Sentry events in ~25h (every
    // fail-open AND fail-closed job hits this path on every invocation).
    captureThrottled(
      "maintenance-cron:readMaintenancePhase",
      error instanceof Error ? error : new Error(String(error)),
      { subsystem: "maintenance", expected: false },
    );
    return null;
  }
}

/** Test-only: clears the phase cache between cases (#1822). */
export function resetMaintenancePhaseCacheForTesting(): void {
  phaseCachedAt = 0;
  phaseCachedValue = null;
  phaseCacheHasValue = false;
}

/**
 * The single phase→verdict rule both guards share: OFFLINE stops everything,
 * DEGRADED stops only the financial jobs, anything else proceeds.
 */
function blockingPhaseFor(
  phase: string | null,
  jobName: string,
): BlockingMaintenancePhase | null {
  if (phase === "OFFLINE") return "OFFLINE";
  if (phase === "DEGRADED" && FINANCIAL_JOB_NAMES.has(jobName)) {
    return "DEGRADED";
  }
  return null;
}

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
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);

  if (blocking === "OFFLINE") {
    console.log(
      `[${jobName}] Maintenance mode is OFFLINE — skipping job to protect DB during migration`,
    );
  } else if (blocking === "DEGRADED") {
    console.log(
      `[${jobName}] Maintenance mode is DEGRADED — skipping financial job to protect payment integrity`,
    );
  } else {
    if (phase === "DEGRADED") {
      console.log(
        `[${jobName}] Maintenance mode is DEGRADED — proceeding (non-financial job)`,
      );
    }
    return;
  }

  // This exit bypasses runJob's finally, so it owns the drain itself —
  // anything the job logged before the guard would be lost. (#1066)
  await flushJobSentry();
  process.exit(0);
}

/**
 * Throwing twin of {@link abortIfMaintenance}, for the HTTP entry points under
 * `app/api/cleanup/**`. Those routes import the same job cores but run inside
 * the Next server, where `process.exit(0)` would take the whole instance down,
 * so the same phase rule surfaces as a `MaintenanceActiveError` the handler
 * answers with 503.
 *
 * @param jobName - Must be the canonical cron job name, not the route segment,
 *   because the DEGRADED branch is keyed on FINANCIAL_JOB_NAMES membership.
 */
export async function assertNotInMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);
  if (blocking) throw new MaintenanceActiveError(jobName, blocking);
}
