import { NextRequest } from "next/server";

import { cleanupRoute, InvalidLimitError } from "@/lib/cron/cleanup-route";
import {
  describeIngest,
  isIngestHealthy,
  probeSentryIngest,
} from "@/lib/observability/ingest-canary";
import {
  sendSentryIngestAlert,
  canaryAlertNeeded,
  recordCanaryAlertSent,
} from "@/lib/observability/ingest-alert";

/**
 * Sentry ingest canary — "is Sentry actually taking our error events?"
 *
 * The HTTP twin every scheduled job has (ADR 27), so this can be driven by the
 * Netlify ticker (every 30 minutes — see TARGET_EVERY_MINUTES), by GitHub
 * Actions, or by hand. It shares the
 * `cleanupRoute` factory rather than hand-rolling the bearer check, the
 * maintenance guard and the cron lock.
 *
 * Why it exists at all: on 2026-09-22 the organisation's error allowance was
 * spent and Sentry began discarding every error event while still returning
 * 200 for sessions and transactions. The app, the deploys and the cron jobs
 * all looked healthy, and the error stream was empty for six days. Nothing
 * else in this system can notice that, because the thing that reports on
 * errors is the thing that had stopped working.
 *
 * It emails the owner on failure rather than only reporting to Sentry, because
 * a check that reports its own failure through the failing system is not a
 * check.
 */
const { GET, POST } = cleanupRoute({
  job: "sentry-ingest-canary",
  run: async (req: NextRequest) => {
    const probe = await probeSentryIngest();
    const healthy = isIngestHealthy(probe);

    if (!healthy) {
      // Best-effort by design: the alert channel is email precisely because
      // Sentry is not a usable one right now. A failure here must not change
      // the probe's verdict.
      //
      // One email per distinct state, re-armed on change and re-asserted daily
      // — without this the 30-minute cadence emails the same content 48 times
      // a day, which is how an alert gets ignored. `alerted` stays false when
      // suppressed, so the response distinguishes "told them" from "told them
      // recently", which are different things to see in a log.
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
      // Armed only when the send actually landed. Arming before the send (or
      // regardless of its result) means one failed delivery suppresses the next
      // 24 hours of alerts about a verdict nobody was told about.
      if (alerted) await recordCanaryAlertSent(probe.verdict);
      return {
        healthy,
        verdict: probe.verdict,
        status: probe.status,
        eventId: probe.eventId,
        alerted,
        alertSuppressed: !needed,
        detail: describeIngest(probe),
      };
    }

    return {
      healthy: true,
      verdict: probe.verdict,
      status: probe.status,
      eventId: probe.eventId,
      alerted: false,
    };
  },
  // 503 rather than 500: the route is healthy, its subject is not. The
  // distinction matters to whoever is reading the cron-tick summary.
  status: (result) => (result.healthy ? 200 : 503),
  // Only ever surfaces on an unexpected throw from `run` (a 500). The canary's
  // *unhealthy* verdict returns 503 with a JSON body, never this string — so
  // the old "Sentry is not accepting error events" here would have been a false
  // diagnosis of the wrong subsystem on a crash in the probe itself.
  failureMessage:
    "The Sentry ingest canary route failed to run. This is a fault in the canary, not a verdict about Sentry — check the log line above.",
});

export { GET, POST };
