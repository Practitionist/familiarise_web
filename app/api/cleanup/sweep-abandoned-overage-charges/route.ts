/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper API endpoint (#785, task #25).
 * CRON_SECRET-gated wrapper. FAILs never-paid PENDING side-charges to free the
 * per-cycle circuit-breaker ceiling. Runs daily.
 */
import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { sweepAbandonedOverageCharges } from "@/scripts/cleanup/sweep-abandoned-overage-charges";

export const { GET, POST } = cleanupRoute({
  job: "sweep-abandoned-overage-charges",
  // #1584 P1-CR03 — forward ?limit= like the sibling twins so the ticker can bound it.
  run: (req) => sweepAbandonedOverageCharges({ limit: parseLimitParam(req) }),
  summarize: (r) => ({ scanned: r.scanned, failed: r.failed }),
  // #1390 review — the constant 200 masked a caught job error (success:false)
  // as healthy; the default statusFor already reads result.success.
  failureMessage: "Failed to sweep abandoned overage charges",
});
