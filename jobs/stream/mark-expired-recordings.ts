/**
 * Mark Expired Recordings Job (GitHub Actions Wrapper)
 *
 * Marks Stream S3 recordings whose URLs have expired as EXPIRED status.
 *
 * Runs daily via scheduled workflow.
 */

import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import fs from "fs";

async function main(): Promise<void> {
  await abortIfMaintenance("mark-expired-recordings");
  const startTime = Date.now();
  console.log("🚀 Starting mark-expired-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  try {
    const expiredCount =
      await RecordingTransferService.markExpiredRecordings();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`   Recordings marked expired: ${expiredCount}`);

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `expired_count=${expiredCount}\nsuccess=true\n`,
      );
    }

    console.log("🎉 Job completed successfully");
  } catch (error) {
    console.error("💥 Job failed:", error);
    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "success=false\n");
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});
