import { z } from "zod";
import { STREAM_LIFECYCLE_JOBS } from "../../lib/cron/schedule";
import { cleanupRoute } from "../../lib/cron/cleanup-route";
import { runBackgroundWorker } from "../../lib/cron/background-worker";

export const config = { background: true };
const jobSchema = z.enum(STREAM_LIFECYCLE_JOBS);

/** The ticker owns scheduling; this narrow adapter executes one selected Stream core. */
export default async function streamMaintenance(
  req: Request,
  context?: unknown,
): Promise<void> {
  const selected = jobSchema.safeParse(
    new URL(req.url).searchParams.get("job"),
  );
  if (!selected.success) {
    console.log(
      JSON.stringify({
        event: "background-worker-refused",
        reason: "unknown-job",
      }),
    );
    return;
  }
  const job = selected.data;
  await runBackgroundWorker(job, req, context, () =>
    cleanupRoute({
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
            return performStreamUserSync({
              dryRun: new URL(req.url).searchParams.get("dry-run") === "true",
            });
          }
          case "expire-event-channels": {
            const { expireEventChannels } =
              await import("../../jobs/stream/expire-event-channels");
            return expireEventChannels();
          }
        }
      },
      failureMessage: "Stream maintenance execution failed",
    }),
  );
}
