/**
 * Sentry ingest canary — bare-Node job twin of
 * `app/api/cleanup/sentry-ingest-canary/route.ts`.
 *
 * Every scheduled job in this repo has both halves (ADR 27): the HTTP twin
 * that the Netlify ticker POSTs (every 30 min), and a bare `tsx` entrypoint that
 * GitHub Actions can run on a schedule of its own. This one earns the second
 * half more than most, because the failure it detects is silent — if the ticker
 * route is itself unreachable, only the Actions run will notice.
 *
 * Run:
 *   npx tsx jobs/observability/sentry-ingest-canary.ts
 */

import {
  describeIngest,
  isIngestHealthy,
  probeSentryIngest,
} from "@/lib/observability/ingest-canary";
import {
  canaryAlertNeeded,
  recordCanaryAlertSent,
  sendSentryIngestAlert,
} from "@/lib/observability/ingest-alert";
import { checkSentryQuota } from "@/lib/observability/quota-alert";
import { runJob } from "@/lib/observability/job-sentry";

export async function runSentryIngestCanary(): Promise<void> {
  const probe = await probeSentryIngest();
  const healthy = isIngestHealthy(probe);
  // #1933 — 70% quota warning; never throws, so it cannot change the verdict.
  await checkSentryQuota();

  if (healthy) {
    // The one thing worth saying on success: that the canary ran at all. A
    // canary that is only ever heard from when it fails is indistinguishable
    // from one that is broken.
    console.log(`[sentry-ingest-canary] OK — ${probe.eventId}`);
    return;
  }

  const summary = describeIngest(probe);
  console.error(`[sentry-ingest-canary] ${summary}`);

  // The SAME cooldown gate the HTTP twin uses. Without it this path emails on
  // every failing Actions run regardless of what the ticker already reported,
  // so whichever scheduler fires more often sets the real alert rate — and the
  // whole point of the cooldown is that the rate is not the scheduler's to
  // choose. Armed on a successful send only, and fail-open.
  const needed = await canaryAlertNeeded(probe.verdict);
  const alerted = needed
    ? await sendSentryIngestAlert(probe).catch((err: unknown) => {
        console.error(
          "[sentry-ingest-canary] alert could not be sent:",
          err instanceof Error ? err.message : String(err),
        );
        return false;
      })
    : false;
  if (alerted) await recordCanaryAlertSent(probe.verdict);
  console.error(
    `[sentry-ingest-canary] verdict=${probe.verdict} status=${probe.status} alerted=${alerted} eventId=${probe.eventId}`,
  );

  // Non-zero so the GitHub Actions failure sink records the run as failed.
  // That sink posts to Sentry, which is the subject of the failure — so the
  // email is the channel that actually reaches a human, and this exit code is
  // what the Actions run's own status reflects.
  process.exitCode = 1;
}

runJob("sentry-ingest-canary", runSentryIngestCanary);
