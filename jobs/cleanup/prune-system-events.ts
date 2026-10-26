import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";
import { pruneSystemEvents } from "@/lib/observability/system-event-retention";

runJob("prune-system-events", async () => {
  const startedAt = Date.now();
  await abortIfMaintenance("prune-system-events");
  try {
    const deadline = startedAt + 16_000;
    for (let slice = 0; slice < 40 && Date.now() < deadline; slice++) {
      const result = await pruneSystemEvents({ limit: 500, startedAt });
      console.log(result);
      if (!result.hasMore || result.pruned === 0) break;
    }
  } finally {
    await prisma.$disconnect();
  }
});
