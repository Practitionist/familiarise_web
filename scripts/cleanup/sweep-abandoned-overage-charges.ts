/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper (#785, task #25).
 *
 * cycleOverageSoFarPaise (overage-settlement.ts) sums basePaise + surchargePaise over
 * chargeStatus NOT IN (REVERSED, BLOCKED, FAILED) — so a never-paid PENDING
 * CHARGE_MEMBER side-charge COUNTS toward maxOveragePerCyclePaise and can
 * hard-block (402 PROGRAM_CAP_EXHAUSTED) the next legitimate booking even though
 * ₹0 was collected. No payment.failed webhook arrives for an abandon-before-pay,
 * so nothing frees the ceiling. This job FAILs abandoned PENDING side-charges; the
 * member can still retry later (FAILED→PENDING via the resume-checkout order route).
 */
import prisma from "@/lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { restoreOverageBaseCarve } from "@/lib/payments/billing/overage-base-carve";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface OverageSweepResult {
  success: boolean;
  scanned: number;
  failed: number;
  /** Rows whose claim threw; each rolled back and stays PENDING for the next run. */
  errored: number;
}

const DEFAULT_AGE_DAYS = 7;

/** Unpaid, never-started CHARGE_MEMBER side-charges created before `cutoff`; shared with the idle probe. */
function abandonedOverageWhere(cutoff: Date): Prisma.OverageEventWhereInput {
  return {
    chargeStatus: "PENDING",
    overageBehavior: "CHARGE_MEMBER",
    createdAt: { lt: cutoff },
    OR: [
      { paymentId: null },
      {
        payment: {
          is: {
            paymentStatus: { not: "SUCCEEDED" },
            paymentIntent: { startsWith: "overage:" },
          },
        },
      },
    ],
  };
}

/** Ticker idle probe at the ticker's default grace window. */
export async function hasAbandonedOverageWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - DEFAULT_AGE_DAYS * 86_400_000);
  if (outOfTime()) return true;
  const row = await db.overageEvent.findFirst({
    where: abandonedOverageWhere(cutoff),
    select: { id: true },
  });
  return row !== null;
}

// #476 — locked at the core so the GH Actions entry (jobs/**) and the
// CRON_SECRET HTTP entry (app/api/cleanup/**) share one mutual exclusion.
// fail-closed: FAILing a side-charge twice would double-free the ceiling.
export async function sweepAbandonedOverageCharges(
  opts: { ageDays?: number; limit?: number } = {},
): Promise<OverageSweepResult> {
  return withCronLock(
    "sweep-abandoned-overage-charges",
    { failMode: "closed" },
    () => sweepAbandonedOverageChargesUnlocked(opts),
  );
}

async function sweepAbandonedOverageChargesUnlocked(
  opts: { ageDays?: number; limit?: number } = {},
): Promise<OverageSweepResult> {
  const failures = createRunFailureReporter("jobs");
  const ageDays = opts.ageDays ?? DEFAULT_AGE_DAYS;
  const limit = opts.limit ?? 500;
  const cutoff = new Date(Date.now() - ageDays * 86_400_000);

  // How many audit writes may be in flight before the loop drains them. Small
  // enough to stay well inside the single-connection pool this job runs under
  // (PG_POOL_MAX=1 in the serverless deploy env, lib/prisma.ts:63) and large
  // enough that the sweep is not serialised one write per iteration.
  const WRITE_BATCH = 10;

  // Abandoned = PENDING CHARGE_MEMBER side-charge older than the grace window
  // whose side-Payment never succeeded AND was never even started at the
  // gateway. #785: the side-Payment's `paymentIntent` is the synthetic
  // `overage:<parentId>` until the member opens resume-checkout, which the
  // order route (app/api/overage/[id]/order) overwrites with the real gateway
  // order id. So `paymentIntent startsWith "overage:"` ⟺ the member never
  // began paying = genuinely abandoned. A charge whose intent was replaced may
  // be captured-but-webhook-stuck; FAILing it would strand collected money
  // (a late capture is now recoverable via FAILED→CHARGED, but don't
  // manufacture that case). The state machine's allowed-from still skips a
  // charge that paid (→CHARGED) between this read and the transition.
  const abandoned = await prisma.overageEvent.findMany({
    where: abandonedOverageWhere(cutoff),
    select: { id: true },
    take: limit,
  });

  if (abandoned.length === 0) {
    return { success: true, scanned: 0, failed: 0, errored: 0 };
  }

  // Per-event tx: the PENDING→FAILED claim (CAS — a side-charge that paid
  // (→CHARGED) between the read and here matches zero rows) and the basePaise
  // restore (#812 §P0) must land together. chargeFailureReason makes the
  // silent write-off auditable (#779 §A) — the 14d timeout cron distinguishes
  // its own FAILs via chargeTimedOutAt.
  let failed = 0;
  let invoicedSkips = 0;
  const pendingRecords: Promise<void>[] = [];
  const receivables: string[] = [];
  const errors: Array<{ overageEventId: string; error: string }> = [];
  for (const a of abandoned) {
    let outcome: Awaited<ReturnType<typeof restoreOverageBaseCarve>> | null;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const moved = await transitionOverage(tx, { id: a.id }, "FAILED", {
          chargeFailureReason: `Payment not started within ${ageDays} days`,
        });
        if (moved === 0) return null;
        // FAILing the side-charge means the member never pays basePaise — give
        // it back to the org's parent accrual so the next rollup bills it.
        return restoreOverageBaseCarve(tx, { overageEventId: a.id });
      });
    } catch (err) {
      errors.push({
        overageEventId: a.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (outcome === null) continue;
    failed += 1;
    if (outcome === "receivable") receivables.push(a.id);
    if (outcome === "invoiced") {
      // Parent already rolled onto an issued invoice with the carved (smaller)
      // base — the org was under-billed for this session. Needs a manual
      // billing adjustment; surface it instead of silently diverging the leg.
      invoicedSkips += 1;
      // Batched, not collected and drained once at the end. Pushing all of
      // them and awaiting a single time starts every insert before the first
      // is awaited: with up to `limit` (default 500) invoiced parents that is
      // 500 concurrent writes against a pool documented at PG_POOL_MAX=1 in
      // the serverless deploy env (lib/prisma.ts:63). They queue past the
      // connection timeout, and because `*Safe` resolves even when a write
      // fails, the sweep can report success having durably recorded nothing —
      // leaving manual billing adjustments with no audit trail.
      //
      // Draining per batch keeps the writes off the calling loop (so the sweep
      // is not serialised one write per iteration) while never holding more
      // than WRITE_BATCH open at once. `*Safe` never rejects, so this cannot
      // throw; it is awaited so a batch is durable before the next starts, and
      // so nothing is lost to the process exiting on an empty event loop.
      const invoicedErr = new Error("OVERAGE_BASE_RESTORE_AFTER_INVOICE");
      failures.add(
        "sweep-abandoned-overage-charges.invoiced-skip",
        invoicedErr,
        { overageEventId: a.id },
      );
      pendingRecords.push(
        recordSystemErrorSafe({
          organizationId: null,
          category: "OVERAGE",
          summary: `Abandoned overage ${a.id}: basePaise not restorable — parent already invoiced; manual billing adjustment needed`,
          err: invoicedErr,
          context: { overageEventId: a.id },
          skipSentry: true,
        }),
      );
      if (pendingRecords.length >= WRITE_BATCH) {
        await Promise.all(pendingRecords);
        pendingRecords.length = 0;
      }
    }
  }
  // Final drain of the last partial batch. `*Safe` never rejects, so this
  // cannot throw; it exists purely so those writes are complete before the
  // process is allowed to exit.
  if (pendingRecords.length > 0) {
    await Promise.all(pendingRecords);
  }
  if (receivables.length > 0 || errors.length > 0) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "OVERAGE",
      summary: `sweep-abandoned-overage-charges: ${receivables.length} abandoned overage(s) booked as ORG_RECEIVABLE (wallet short of the base), ${errors.length} row(s) failed and stay PENDING`,
      err: new Error("OVERAGE_SWEEP_RUN_NEEDS_FINANCE"),
      context: { receivableOverageEventIds: receivables, errors },
    });
  }

  failures.flush();
  console.log(
    `🧹 Failed ${failed} abandoned CHARGE_MEMBER overage charge(s) — circuit-breaker ceiling freed` +
      (invoicedSkips > 0
        ? ` (${invoicedSkips} need manual billing adjustment — parent already invoiced)`
        : ""),
  );
  return {
    success: true,
    scanned: abandoned.length,
    failed,
    errored: errors.length,
  };
}
