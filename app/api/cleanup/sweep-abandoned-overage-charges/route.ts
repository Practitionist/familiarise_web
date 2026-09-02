/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper API endpoint (#785, task #25).
 * CRON_SECRET-gated wrapper. FAILs never-paid PENDING side-charges to free the
 * per-cycle circuit-breaker ceiling. Runs daily.
 */
import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { sweepAbandonedOverageCharges } from "@/scripts/cleanup/sweep-abandoned-overage-charges";

export const { GET, POST } = cleanupRoute({
  job: "sweep-abandoned-overage-charges",
  run: () => sweepAbandonedOverageCharges(),
  summarize: (r) => ({ scanned: r.scanned, failed: r.failed }),
  status: () => 200,
  failureMessage: "Failed to sweep abandoned overage charges",
});
