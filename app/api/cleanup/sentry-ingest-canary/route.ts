import { NextRequest } from "next/server";

import { cleanupRoute, InvalidLimitError } from "@/lib/cron/cleanup-route";
import {
  describeIngest,
  isIngestHealthy,
  probeSentryIngest,
} from "@/lib/observability/ingest-canary";
import { sendSentryIngestAlert } from "@/lib/observability/ingest-alert";

/**
 * Sentry ingest canary — "is Sentry actually taking our error events?"
 *
 * The HTTP twin every scheduled job has (ADR 27), so this can be driven by the
 * five-minute Netlify ticker, by GitHub Actions, or by hand. It shares the
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
      const alerted = await sendSentryIngestAlert(probe).catch(
        (err: unknown) => {
          console.error(
            "[sentry-ingest-canary] alert could not be sent:",
            err instanceof Error ? err.message : String(err),
          );
          return false;
        },
      );
      return {
        healthy,
        verdict: probe.verdict,
        status: probe.status,
        eventId: probe.eventId,
        alerted,
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
  failureMessage:
    "Sentry is not accepting error events — see the response body",
});

export { GET, POST };
