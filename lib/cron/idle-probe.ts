import type { Db } from "@/lib/prisma";
import { CLEANUP_JOB_BUILDERS } from "@/lib/cron/cleanup-registry";

/** Probing stops at this budget; a target the budget never reached is dispatched. */
export const IDLE_PROBE_BUDGET_MS = 2_500;

/**
 * The due targets whose idle probe found no work. Probes run one at a time on
 * the single connection; a probe that throws, or an always-run job, keeps its target.
 */
export async function idleTargets(
  due: readonly string[],
  db: Db,
  now = new Date(),
  deadline = Date.now() + IDLE_PROBE_BUDGET_MS,
): Promise<string[]> {
  const idle: string[] = [];
  const failed: string[] = [];
  for (const name of due) {
    if (Date.now() >= deadline) break;
    const probe = Object.hasOwn(CLEANUP_JOB_BUILDERS, name)
      ? CLEANUP_JOB_BUILDERS[name].idle
      : null;
    if (!probe || !("hasWork" in probe)) continue;
    try {
      if (!(await probe.hasWork(db, now))) idle.push(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.warn(
      JSON.stringify({ event: "idle-probe-failed", targets: failed }),
    );
  }
  return idle;
}
