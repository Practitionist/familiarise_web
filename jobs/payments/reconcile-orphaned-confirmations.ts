/**
 * #830 — orphaned-confirmation re-drive (GitHub Actions wrapper). Finds
 * SUCCEEDED payments whose slots are still tentative and re-runs the
 * confirmation under the webhook's own Serializable discipline. Runs every
 * 30 minutes.
 */
import {
  reconcileOrphanedConfirmations,
  disconnectDatabase,
} from "../../scripts/payments/reconcile-orphaned-confirmations";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-orphaned-confirmations");
  Sentry.logger.info("job:reconcile-orphaned-confirmations started");
  console.log("🩹 Starting orphaned-confirmation reconcile...");
  try {
    const result = await reconcileOrphanedConfirmations();
    console.log(
      `Done. scanned=${result.scanned} confirmed=${result.confirmed} stillBlocked=${result.stillBlocked}`,
    );
    Sentry.logger.info("job:reconcile-orphaned-confirmations finished", {
      scanned: result.scanned,
      confirmed: result.confirmed,
      stillBlocked: result.stillBlocked,
    });
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      Sentry.logger.info("job:reconcile-orphaned-confirmations lock held — skipping");
      console.log(`⏭️  ${error.message}`);
      return;
    }
    Sentry.captureException(error, { tags: { subsystem: "jobs", job: "reconcile-orphaned-confirmations" } });
    console.error("❌ Fatal error in orphaned-confirmation reconcile:", error);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-orphaned-confirmations", main);
