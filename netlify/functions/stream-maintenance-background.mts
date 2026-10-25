import { NextRequest } from "next/server.js";
import { z } from "zod";
import { cleanupRoute } from "../../lib/cron/cleanup-route";
import {
  initJobSentry,
  flushJobSentry,
} from "../../lib/observability/job-sentry";

export const config = { background: true };
const jobSchema = z.enum([
  "expire-recordings",
  "reconcile-orphaned-recordings",
  "wind-down-deactivated-orgs",
  "stream-sync",
  "expire-event-channels",
]);

/** The ticker owns scheduling; this narrow adapter executes one selected Stream core. */
export default async function streamMaintenance(req: Request): Promise<void> {
  if (req.method !== "POST") return;
  initJobSentry();
  try {
    const job = jobSchema.parse(new URL(req.url).searchParams.get("job"));
    const handlers = cleanupRoute({
      job,
      run: async () => {
        switch (job) {
          case "expire-recordings": {
            const { expireRecordings } =
              await import("../../lib/stream/recording-retention");
            return expireRecordings();
          }
          case "reconcile-orphaned-recordings": {
            const { reconcileOrphanedRecordings } =
              await import("../../scripts/stream/reconcile-orphaned-recordings");
            return reconcileOrphanedRecordings();
          }
          case "wind-down-deactivated-orgs": {
            const { windDownDeactivatedOrgs } =
              await import("../../jobs/stream/wind-down-deactivated-orgs");
            return windDownDeactivatedOrgs();
          }
          case "stream-sync": {
            const { performStreamUserSync } =
              await import("../../scripts/stream/stream-sync");
            return performStreamUserSync();
          }
          case "expire-event-channels": {
            const { expireEventChannels } =
              await import("../../jobs/stream/expire-event-channels");
            return expireEventChannels();
          }
        }
      },
      failureMessage: "Stream maintenance execution failed",
    });
    const response = await handlers.POST(new NextRequest(req));
    if (response.status >= 500)
      throw new Error(
        `Stream maintenance worker returned HTTP ${response.status}`,
      );
  } finally {
    await flushJobSentry();
  }
}
