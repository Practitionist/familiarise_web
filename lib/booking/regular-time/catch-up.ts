/**
 * Catch-up: a plan behind its cadence may hold one extra session a week (still
 * at most one a zone-day) until the backlog is gone, inside the plan end.
 * Prisma-free: the entitlement and client components import it.
 */

export interface CatchUpInput {
  /** Frozen cadence: `sub.sessionsPerWeek ?? plan.sessionsPerWeek`. */
  perWeek: number;
  /** Sessions sold. */
  sessionsTotal: number;
  /** Sessions a support partial refund removed from the plan. */
  sessionsRefunded: number;
  /** Delivered + held sessions per zero-based plan week. */
  heldByWeek: readonly number[];
  /** Zone-days of week k inside the plan (7, fewer for a short last week). */
  daysInWeek: (k: number) => number;
}

/** Sessions held before plan week k. */
function heldBefore(input: CatchUpInput, k: number): number {
  let n = 0;
  for (let i = 0; i < Math.min(k, input.heldByWeek.length); i++) {
    n += input.heldByWeek[i] ?? 0;
  }
  return n;
}

/** What remains schedulable of the plan, ignoring week k's own sessions. */
function remainingFor(input: CatchUpInput, k: number): number {
  const schedulable = Math.max(0, input.sessionsTotal - input.sessionsRefunded);
  const heldElsewhere =
    input.heldByWeek.reduce((a, b) => a + b, 0) - (input.heldByWeek[k] ?? 0);
  return Math.max(0, schedulable - heldElsewhere);
}

/**
 * Sessions behind cadence at the start of week k: perWeek·k less what was held
 * before it and what a support refund removed, never more than what remains.
 */
export function backlog(input: CatchUpInput, k: number): number {
  const behind =
    input.perWeek * k - heldBefore(input, k) - input.sessionsRefunded;
  return Math.max(0, Math.min(behind, remainingFor(input, k)));
}

/** Week k's capacity: perWeek, +1 while there is a backlog, ≤ 1 a day, ≤ what remains. */
export function weekCapacity(input: CatchUpInput, k: number): number {
  const wanted = input.perWeek + (backlog(input, k) > 0 ? 1 : 0);
  return Math.max(
    0,
    Math.min(wanted, input.daysInWeek(k), remainingFor(input, k)),
  );
}
