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

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-orphaned-confirmations");
  console.log("🩹 Starting orphaned-confirmation reconcile...");
  try {
    const result = await reconcileOrphanedConfirmations();
    console.log(
      `Done. scanned=${result.scanned} confirmed=${result.confirmed} stillBlocked=${result.stillBlocked}`,
    );
  } catch (error) {
    // #476 — lock held = another run is live; skip cleanly (exit 0).
    if (error instanceof CronLockHeldError) {
      console.log(`⏭️  ${error.message}`);
      return;
    }
    console.error("❌ Fatal error in orphaned-confirmation reconcile:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
