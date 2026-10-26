import "dotenv/config";
import {
  pruneSystemJobExecutions,
  disconnectDatabase,
} from "../../scripts/cleanup/prune-system-job-executions";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

if (require.main === module) {
  runJob("prune-system-job-executions", async () => {
    const startedAt = Date.now();
    await abortIfMaintenance("prune-system-job-executions");
    try {
      const deadline = startedAt + 16_000;
      for (let slice = 0; slice < 40 && Date.now() < deadline; slice++) {
        const result = await pruneSystemJobExecutions({
          limit: 500,
          startedAt,
        });
        console.log(JSON.stringify(result));
        if (result.stranded > 0) {
          console.warn(
            `Closed ${result.stranded} executions with stale heartbeats`,
          );
        }
        const progress =
          result.pruned +
          result.stranded +
          result.failedEmailsBodyScrubbed +
          result.failedEmailBatchesScrubbed +
          result.failedEmailsPruned +
          result.failedEmailBatchesPruned +
          result.notificationOutboxPruned +
          result.emailEventsPruned;
        if (!result.hasMore || progress === 0) break;
      }
    } finally {
      await disconnectDatabase();
    }
  });
}
