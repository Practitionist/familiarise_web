/**
 * GitHub Actions entry for `transfer-recordings`; the work and its lock live in
 * lib/stream/recording-transfer-service.ts.
 */

import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";
import { transferRecordings } from "../../lib/stream/recording-transfer-service";

runJob("transfer-recordings", async () => {
  await abortIfMaintenance("transfer-recordings");
  try {
    const result = await transferRecordings();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
});
