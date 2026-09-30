/**
 * Stream usage meter — nightly GitHub Actions entry point (issue #1134 E5).
 *
 * The ONLY alarm in the repository for Stream's pricing ceilings used to be a
 * sentence in a doc. This is that alarm: it computes what we can compute for
 * free (participant-minutes and peak concurrency, from attendance rows we
 * already store), folds in the live MAU counter, writes one Redis hash, and
 * raises a throttled Sentry event at 60% / 80% / 90% of Stream's Maker caps.
 *
 * ## Why a GitHub Actions workflow and not a ticker target
 *
 * The Netlify ticker (`netlify/functions/cron-tick.mts`) runs every five
 * minutes and can only express cadences in whole minutes against
 * `TARGET_EVERY_MINUTES`. A daily job does not fit: `minute % 1440 < 5` fires at
 * the top of every hour, not once a day. Bolting an exception into the ticker to
 * special-case one daily target would put a per-target branch in the most
 * cost-sensitive function in the deployment for the sake of a job that runs
 * 0.006% as often. Actions is already the repo's daily scheduler and the
 * unbounded backstop (ADR 27), so the job lives there and the HTTP twin exists
 * for manual re-drives and for the local dev-server recipe.
 *
 * ## Command cost
 *
 * One `HSET` + one `EXPIRE` per run, plus two reads for the fold. Two commands
 * a day is ~730/month against a 500k cap — see `lib/stream/usage.ts` for the
 * full accounting of the whole feature, including the per-mint MAU counter that
 * dominates it.
 */

import * as Sentry from "@sentry/nextjs";

import { runJob } from "../../lib/observability/job-sentry";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { runStreamUsageMeter } from "../../lib/stream/usage-estimator";

async function main(): Promise<void> {
  await abortIfMaintenance("stream-usage-meter");
  Sentry.logger.info("job:stream-usage-meter started");
  const started = Date.now();

  // #476 — entry-level cron lock. `failMode: "open"`: the job is a pure
  // read plus one idempotent Redis write of a snapshot that is recomputed from
  // scratch every night, so a double-run costs two `HSET`s and nothing else. It
  // is fail-open for the reason E2 fixed: during a Redis outage the job STILL
  // RAN, computes the Postgres half (which needs no Redis at all), and fails
  // only on the snapshot write. Before that fix this job would have been one of
  // the silent 409 skips.
  const estimate = await withCronLock(
    "stream-usage-meter",
    { failMode: "open" },
    () => runStreamUsageMeter(),
  );

  const durationMs = Date.now() - started;
  const { snapshot } = estimate;

  console.log(
    JSON.stringify({
      event: "stream-usage-meter",
      mau: snapshot.mau,
      participantMinutes: snapshot.participantMinutes,
      peakConcurrency: snapshot.peakConcurrency,
      examinedRows: estimate.examinedRows,
      droppedRows: estimate.droppedRows,
      estimated: snapshot.estimated,
      durationMs,
      timestamp: snapshot.computedAt,
    }),
  );

  Sentry.logger.info("job:stream-usage-meter finished", {
    mau: snapshot.mau,
    participantMinutes: snapshot.participantMinutes,
    peakConcurrency: snapshot.peakConcurrency,
    durationMs,
  });
}

runJob("stream-usage-meter", main);
