/**
 * Ledger reconcile HTTP twin (#1454).
 *
 * One call advances one run by a bounded chunk and answers with the run's
 * state; the background driver loops it until `status` is COMPLETED. With no
 * `?runId=` it opens a fresh full-scope run and advances that, so a manual
 * `curl` can drive a run too; `?runId=&abandon=<reason>` closes a run as
 * FAILED instead. `?limit=` caps the rows a chunk walks (shared
 * `parseLimitParam` rules); the soft RECONCILE_CHUNK_BUDGET_MS deadline is the
 * real bound, because the cost per row is a few serialised queries, not one.
 * The nightly GitHub Actions job keeps the unbounded single-process path.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import {
  advanceReconcileRun,
  markReconcileRunFailed,
} from "@/scripts/reconcile/reconcile-ledgers";

const QuerySchema = z.object({
  runId: z.string().uuid().optional(),
  triggeredById: z.string().min(1).max(64).optional(),
  /** Close `runId` as FAILED with this reason instead of advancing it. */
  abandon: z.string().min(1).max(500).optional(),
});

export const { GET, POST } = cleanupRoute({
  job: "reconcile-ledgers",
  run: async (req) => {
    const limit = parseLimitParam(req);
    const q = QuerySchema.parse({
      runId: req.nextUrl.searchParams.get("runId") ?? undefined,
      triggeredById: req.nextUrl.searchParams.get("triggeredById") ?? undefined,
      abandon: req.nextUrl.searchParams.get("abandon") ?? undefined,
    });
    // The driver has no Prisma; this is how it closes a run it gave up on.
    if (q.abandon && q.runId) {
      await markReconcileRunFailed(q.runId, q.abandon);
      return {
        success: true as const,
        runId: q.runId,
        scope: "full",
        status: "FAILED" as const,
        progress: null,
        report: null,
        error: q.abandon,
      };
    }
    const snap = await advanceReconcileRun({
      runId: q.runId ?? randomUUID(),
      ...(limit === undefined ? {} : { limit }),
      createIfMissing: { scope: "full", triggeredById: q.triggeredById },
    });
    return { success: true as const, ...snap };
  },
  summarize: (r) => ({
    runId: r.runId,
    status: r.status,
    step: r.progress?.step ?? null,
    calls: r.progress?.calls ?? r.report?.summary.calls ?? null,
    ok: r.report?.ok ?? null,
  }),
  // A finished run with active findings is one an operator has to read.
  status: (r) => statusFor(r, r.report !== null && !r.report.ok),
  failureMessage: "Failed to advance ledger reconciliation",
});
