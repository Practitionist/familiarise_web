import "dotenv/config";
import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";
import { runDataBreachDeadlineAlerts } from "@/lib/compliance/databreach-deadline-alerts";

runJob("databreach-deadline-alerts", async () => {
  await abortIfMaintenance("databreach-deadline-alerts");
  try {
    const result = await runDataBreachDeadlineAlerts({ limit: 50 });
    console.log(result);
    if (!result.success) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
});
