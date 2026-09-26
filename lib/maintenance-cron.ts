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
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";

// #1527 — the financial job list lives in a pure module so the System jobs
// console (a client component) can read it without importing Redis.
export { FINANCIAL_JOB_NAMES, isFinancialJob } from "@/lib/cron/financial-jobs";

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
// Owner decision (#1822): a fail-open null is cached 5s only, so a blip can't
// let DEGRADED-gated money jobs through for a full minute.
const PHASE_FAILURE_CACHE_MS = 5_000;
let phaseCacheTtlMs = PHASE_CACHE_MS;
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
  if (phaseCacheHasValue && now - phaseCachedAt < phaseCacheTtlMs) {
    return phaseCachedValue;
  }

  try {
    // Shared node client (#1822 Q-5) — cron jobs used to mint a fresh client
    // per invocation; that's the same GET, paid again for no reason.
    const phase = await redis.get<string>("maintenance:phase");
    phaseCachedValue = phase;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_CACHE_MS;
    return phase;
  } catch (error) {
    // Fail-open: if Redis is unreachable, proceed with the job; the null is
    // cached for the short failure window only.
    console.warn(
      `[${jobName}] Could not check maintenance state (Redis error: ${
        error instanceof Error ? error.message : String(error)
      }) — proceeding`,
    );
    phaseCachedValue = null;
    phaseCacheHasValue = true;
    phaseCachedAt = now;
    phaseCacheTtlMs = PHASE_FAILURE_CACHE_MS;
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
  phaseCacheTtlMs = PHASE_CACHE_MS;
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
