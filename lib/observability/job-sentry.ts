/**
 * Sentry bootstrap for Netlify background functions, which run outside Next's
 * instrumentation hook. `initJobSentry` initialises Sentry before the work and
 * `flushJobSentry` drains the transport after it, so queued events survive the
 * invocation ending. Jobs produce no spans (`tracesSampleRate` is pinned to 0),
 * and a local run with a development Sentry environment stays disabled.
 */

// Core exposes these generic APIs as real named exports to native ESM workers.
import * as Sentry from "@sentry/core";
import { initSentry } from "@/sentry.shared.config";

/** Drain budget; callers that queue events in a loop pass a larger one. */
export const JOB_FLUSH_TIMEOUT_MS = 5_000;

/** Jobs emit no spans; the app's NODE_ENV-keyed rate would resolve to 100% here. */
const JOB_TRACES_SAMPLE_RATE = 0;

/** Sentry environments that mean "a developer's machine", not a deployment. */
const LOCAL_SENTRY_ENVIRONMENTS = new Set(["development", "test", "local"]);

/**
 * Gate on the Sentry environment, not NODE_ENV: a background process may have
 * no NODE_ENV, while a developer's `.env` sets the environment to `development`.
 */
function isDeployedJobEnvironment(): boolean {
  const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
  if (!environment) return false;
  return !LOCAL_SENTRY_ENVIRONMENTS.has(environment);
}

let initialised = false;

/** Idempotent — job modules import one another, and tests re-enter this. */
export function initJobSentry(): void {
  if (initialised) return;
  initialised = true;
  try {
    const deployed = isDeployedJobEnvironment();
    if (!deployed) {
      // Loud on purpose: a missing env var looks identical to a laptop.
      console.log(
        `[job-sentry] disabled — NEXT_PUBLIC_SENTRY_ENVIRONMENT is ${
          process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "unset"
        }, which is not a deployed environment. Errors will not reach Sentry.`,
      );
    }
    // Reuse the app's single init; the overrides only ever narrow it.
    initSentry({
      ...(deployed ? {} : { enabled: false }),
      tracesSampleRate: JOB_TRACES_SAMPLE_RATE,
    });
  } catch (err) {
    // Telemetry setup failing must not stop the job or reject.
    console.error("[job-sentry] init failed; job runs uninstrumented:", err);
  }
}

/**
 * Drain the transport. Never throws: a job that completed its work must not go
 * red because telemetry could not be delivered.
 */
export async function flushJobSentry(
  timeoutMs: number = JOB_FLUSH_TIMEOUT_MS,
): Promise<void> {
  try {
    // flush resolves false on timeout rather than throwing; the events are lost.
    const drained = await Sentry.flush(timeoutMs);
    if (!drained) {
      console.warn(
        `[job-sentry] flush timed out after ${timeoutMs}ms; queued events were dropped`,
      );
    }
  } catch (err) {
    console.warn("[job-sentry] flush failed:", err);
  }
}
