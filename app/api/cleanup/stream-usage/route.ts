/**
 * POST /api/cleanup/stream-usage — the HTTP twin of the nightly usage meter
 * (issue #1134 E5).
 *
 * Exists for the same reason every other `/api/cleanup/*` route does: the GitHub
 * Actions schedule is best-effort with no SLA (ADR 22), so a job that produces
 * the platform's ONLY Stream-billing alarm must be drivable by hand. It is
 * `CRON_SECRET`-gated, maintenance-gated and lock-wrapped by
 * `cleanupRoute` + `withCronLock`, so a manual re-drive during an Actions run is
 * a 409 rather than a double compute.
 *
 * Deliberately NOT a ticker target — see `jobs/stream/stream-usage-meter.ts` for
 * why a daily job cannot be expressed in `TARGET_EVERY_MINUTES` and why
 * special-casing it in the five-minute ticker would be the wrong trade.
 *
 * 207 rather than 200 when the estimator hit its row cap: the run succeeded and
 * wrote a snapshot, but `participantMinutes` is a FLOOR for that run rather than
 * an estimate, and an operator needs to be able to tell those apart from the
 * normal case without opening the function log.
 */
import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { runStreamUsageMeter } from "@/lib/stream/usage-estimator";

export const { GET, POST } = cleanupRoute({
  job: "stream-usage-meter",
  run: () => runStreamUsageMeter(),
  summarize: (r) => ({
    mau: r.snapshot.mau,
    participantMinutes: r.snapshot.participantMinutes,
    peakConcurrency: r.snapshot.peakConcurrency,
    examinedRows: r.examinedRows,
    droppedRows: r.droppedRows,
    estimated: r.snapshot.estimated,
    computedAt: r.snapshot.computedAt,
  }),
  // 207 = "ran, and there is something for a human to know" (see header).
  status: (r) => (r.droppedRows > 0 ? 207 : 200),
  failureMessage: "Failed to compute Stream usage",
});
