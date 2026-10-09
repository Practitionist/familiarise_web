/**
 * GitHub Actions entry for `expire-recordings`; the work and its lock live in
 * lib/stream/recording-retention.ts.
 */

import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import { expireRecordings } from "../../lib/stream/recording-retention";

runJob("expire-recordings", async () => {
  await abortIfMaintenance("expire-recordings");
  try {
    const result = await expireRecordings();
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
});
