import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";
import { runConsentRetentionSweeper } from "@/lib/compliance/consent-retention";

runJob("consent-retention-sweeper", async () => {
  const startedAt = Date.now();
  const dryRun = process.argv.includes("--dry-run");
  await abortIfMaintenance("consent-retention-sweeper");
  try {
    const deadline = startedAt + 16_000;
    for (let slice = 0; slice < 40 && Date.now() < deadline; slice++) {
      const result = await runConsentRetentionSweeper({
        limit: 500,
        startedAt,
        dryRun,
      });
      console.log(result);
      if (!result.deleteMode || !result.hasMore || result.deleted === 0) break;
    }
  } finally {
    await prisma.$disconnect();
  }
});
