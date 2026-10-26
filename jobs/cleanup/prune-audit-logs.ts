/** The existing daily Actions driver drains bounded slices within one start budget. */
import "dotenv/config";
import {
  pruneAuditLogs,
  disconnectDatabase,
} from "../../scripts/cleanup/prune-audit-logs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

runJob("prune-audit-logs", async () => {
  await abortIfMaintenance("prune-audit-logs");
  const startedAt = Date.now();
  let scanned = 0;
  let deleted7y = 0;
  let deleted2y = 0;
  let perOrgSummaries = 0;
  let hasMore = true;
  Sentry.logger.info("job:prune-audit-logs started");
  try {
    for (
      let slice = 0;
      slice < 40 && Date.now() - startedAt < 16_000;
      slice++
    ) {
      const result = await pruneAuditLogs({ limit: 500, startedAt });
      scanned += result.scanned;
      deleted7y += result.deleted7y;
      deleted2y += result.deleted2y;
      perOrgSummaries += result.perOrgSummaries;
      hasMore = result.hasMore;
      console.log(JSON.stringify(result));
      if (!result.success) {
        process.exitCode = 1;
        return;
      }
      if (!hasMore || result.deleted7y + result.deleted2y === 0) break;
    }
    Sentry.logger.info("job:prune-audit-logs finished", {
      scanned,
      deleted7y,
      deleted2y,
      perOrgSummaries,
      hasMore,
    });
  } finally {
    await disconnectDatabase();
  }
});
