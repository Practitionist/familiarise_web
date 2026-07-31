/**
 * Sentry bootstrap for cron job processes — #1066.
 *
 * Jobs run as bare Node processes (`npx tsx jobs/<area>/<job>.ts` under GitHub
 * Actions). Next's instrumentation hook is the only thing in this repo that
 * ever calls `Sentry.init`, and it never fires there, so every
 * `captureException` under `jobs/**` was a silent no-op.
 *
 * `init` alone would not have fixed it. The SDK batches events over HTTP and a
 * cron process exits the instant its work is done, well before the transport
 * drains. So this module owns BOTH halves — init before the body, flush in a
 * `finally` after it — instead of leaving 58 entrypoints to each remember the
 * second one. jobs/reconcile/reconcile-ledgers.ts had already hand-rolled a
 * flush (#837) and now inherits it like everything else.
 *
 * Corollary the whole mechanism rests on: a job body must never call
 * `process.exit()`. It tears the process down synchronously, so the flush —
 * and any `finally` that disconnects Prisma — never runs. Set
 * `process.exitCode` and return instead.
 */

import * as Sentry from "@sentry/nextjs";
import { initSentry } from "@/sentry.shared.config";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Drain budget. Generous relative to the 2s the ledger job used for its single
 * page, because a failing run can have queued several events and GitHub-hosted
 * runners sit on shared networking.
 */
export const JOB_FLUSH_TIMEOUT_MS = 5_000;

let initialised = false;

/** Idempotent — job modules import one another, and tests re-enter this. */
export function initJobSentry(): void {
  if (initialised) return;
  initialised = true;
  // Reuse the app's single init: DSN, environment, sampling and PII (#901)
  // must not fork into a second, drifting definition for jobs.
  initSentry();
}

/**
 * Drain the transport. Never throws: a job that completed its work must not go
 * red because telemetry could not be delivered.
 */
export async function flushJobSentry(
  timeoutMs: number = JOB_FLUSH_TIMEOUT_MS,
): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    console.warn("[job-sentry] flush failed:", err);
  }
}

/**
 * Run a job body with Sentry initialised around it and flushed after it — on
 * success, on an early `return`, and on a throw.
 *
 * An escaping error is captured and turns the exit code non-zero rather than
 * being rethrown: an unhandled rejection would kill the process before the
 * flush it just queued an event for could finish.
 */
export async function runJobWithSentry(
  jobName: string,
  body: () => Promise<void>,
): Promise<void> {
  initJobSentry();
  try {
    await body();
  } catch (err) {
    reportSentryError(err, { subsystem: "jobs", tags: { job: jobName } });
    console.error(`[${jobName}] Fatal:`, err);
    process.exitCode = 1;
  } finally {
    await flushJobSentry();
  }
}

/**
 * Module-tail form: `runJob("expire-contracts", main);`. Fire-and-forget by
 * design — Node keeps the process alive until the returned promise settles.
 */
export function runJob(jobName: string, body: () => Promise<void>): void {
  void runJobWithSentry(jobName, body);
}
