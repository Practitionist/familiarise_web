/**
 * Transfer Expiring Recordings Job (GitHub Actions Wrapper)
 *
 * Auto-transfers SUPABASE_PERMANENT recordings from Stream S3 to Supabase.
 * Also identifies STREAM_ONLY recordings expiring soon for warnings.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import fs from "fs";

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("🚀 Starting transfer-expiring-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  try {
    // Auto-transfer SUPABASE_PERMANENT recordings expiring in 5 days
    const result = await RecordingTransferService.processExpiringRecordings(
      5,
      10,
      "SUPABASE_PERMANENT",
    );

    // Find STREAM_ONLY recordings expiring in 3 days (for warnings)
    const expiringStreamOnly =
      await RecordingTransferService.getExpiringStreamOnlyRecordings(3);

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
    console.log(`   Transferred: ${result.succeeded}`);
    console.log(`   Failed: ${result.failed}`);
    console.log(`   STREAM_ONLY expiring soon: ${expiringStreamOnly.length}`);

    if (result.errors.length > 0) {
      console.warn("   Errors:", result.errors.join("; "));
    }

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `transferred=${result.succeeded}\nfailed=${result.failed}\nexpiring_stream_only=${expiringStreamOnly.length}\nsuccess=true\n`,
      );
    }

    if (result.failed > 0) {
      console.warn("⚠️ Some transfers failed");
      process.exit(1);
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
