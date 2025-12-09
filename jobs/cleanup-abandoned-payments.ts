/**
 * Abandoned Payment Cleanup Job (GitHub Actions Version)
 *
 * Thin wrapper around the core cleanup logic in scripts/cleanup-abandoned-payments.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
  disconnectDatabase,
  type CleanupResult,
} from "../scripts/cleanup-abandoned-payments.js";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(
  paymentResult: CleanupResult,
  consultationResult: CleanupResult,
  overallSuccess: boolean,
): void {
  if (!process.env.GITHUB_ACTIONS) return;

  // Payment cleanup outputs
  console.log(`::set-output name=cleaned_count::${paymentResult.cleanedCount}`);
  console.log(`::set-output name=error_count::${paymentResult.errorCount}`);
  console.log(
    `::set-output name=total_processed::${paymentResult.totalProcessed}`,
  );

  // Consultation cleanup outputs
  console.log(
    `::set-output name=consultation_cleaned_count::${consultationResult.cleanedCount}`,
  );
  console.log(
    `::set-output name=consultation_error_count::${consultationResult.errorCount}`,
  );

  // Overall success
  console.log(`::set-output name=success::${overallSuccess}`);

  if (!overallSuccess) {
    const allErrors = [
      ...paymentResult.errors,
      ...consultationResult.errors,
    ].join("; ");
    console.log(`::error::Cleanup job completed with errors: ${allErrors}`);
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    // Run abandoned payment cleanup
    const paymentResult = await cleanupAbandonedPayments();

    // Run expired consultation cleanup
    const consultationResult = await cleanupExpiredApprovalPendingPayments();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Combined summary
    console.log(`\n📊 Overall Cleanup Summary:`);
    console.log(
      `   🧹 Abandoned payments cleaned: ${paymentResult.cleanedCount}`,
    );
    console.log(
      `   🧹 Expired consultations reset: ${consultationResult.cleanedCount}`,
    );
    console.log(
      `   ❌ Total errors: ${paymentResult.errorCount + consultationResult.errorCount}`,
    );

    // Determine overall success
    const overallSuccess = paymentResult.success && consultationResult.success;

    // Output to GitHub Actions
    outputToGitHubActions(paymentResult, consultationResult, overallSuccess);

    if (overallSuccess) {
      console.log("🎉 Cleanup job completed successfully");
      process.exit(0);
    } else {
      console.error("❌ Cleanup job completed with errors");
      process.exit(1);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("💥 Cleanup job failed:", errorMessage);

    if (process.env.GITHUB_ACTIONS) {
      console.log(`::set-output name=success::false`);
      console.log(`::error::Cleanup job failed: ${errorMessage}`);
    }

    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

// Run the cleanup job
main().catch((error) => {
  console.error("\n❌ Cleanup job failed:");
  console.error(error);
  process.exit(1);
});
