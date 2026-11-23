import type { Db } from "@/lib/prisma";
import { CLEANUP_JOB_BUILDERS } from "@/lib/cron/cleanup-registry";
import { readPendingAges } from "@/lib/cron/pending-ages";
import type { PendingAges } from "@/lib/observability/betterstack-telemetry";

/** No probe statement starts after this budget; a target the budget never reached is dispatched. */
export const IDLE_PROBE_BUDGET_MS = 2_000;

/**
 * Postgres cancels any one probe statement after this, so probing ends by 2.75 s;
 * with the commit and the claim insert the reply leaves ~2 s of the 5 s claim timeout for a cold start.
 */
export const IDLE_PROBE_STATEMENT_TIMEOUT_MS = 750;

export interface TickProbe {
  /** Due targets whose probe found no work. */
  idle: string[];
  /** The queue gauges, or null when the budget ran out or a statement failed. */
  pendingAges: PendingAges | null;
}

/**
 * The due targets whose idle probe found no work, then the queue gauges. Probes
 * run one at a time in one transaction whose `SET LOCAL statement_timeout` holds
 * through the transaction pooler. A probe that throws, a cancelled statement or
 * an always-run job keeps its target; a failed statement aborts the transaction,
 * so probing stops there. The gauges start only inside the budget, after the
 * probes, so a gauge fault never changes which targets are dispatched.
 */
export async function probeTick(
  due: readonly string[],
  db: Db,
  now = new Date(),
  deadline = Date.now() + IDLE_PROBE_BUDGET_MS,
): Promise<TickProbe> {
  const outOfTime = () => Date.now() >= deadline;
  const probes = due.flatMap((name) => {
    const probe = Object.hasOwn(CLEANUP_JOB_BUILDERS, name)
      ? CLEANUP_JOB_BUILDERS[name].idle
      : null;
    return probe && "hasWork" in probe
      ? [{ name, hasWork: probe.hasWork }]
      : [];
  });
  const result: TickProbe = { idle: [], pendingAges: null };
  const failed: string[] = [];
  if (outOfTime()) return result;
  const remaining = Math.max(1, deadline - Date.now());
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(IDLE_PROBE_STATEMENT_TIMEOUT_MS)}, true)`;
        for (const { name, hasWork } of probes) {
          if (outOfTime()) break;
          try {
            if (!(await hasWork(tx, now, outOfTime))) result.idle.push(name);
          } catch {
            failed.push(name);
            break;
          }
        }
        if (failed.length > 0 || outOfTime()) return;
        try {
          result.pendingAges = await readPendingAges(tx, now, outOfTime);
        } catch {
          console.warn(JSON.stringify({ event: "pending-ages-failed" }));
        }
      },
      {
        maxWait: remaining,
        timeout: remaining + IDLE_PROBE_STATEMENT_TIMEOUT_MS,
      },
    );
  } catch {
    // Every answer read before the failure stands; the rest are dispatched.
  }
  if (failed.length > 0) {
    console.warn(
      JSON.stringify({ event: "idle-probe-failed", targets: failed }),
    );
  }
  return result;
}
