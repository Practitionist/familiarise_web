/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Returns `[]` ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is logged for observability. (#925 review.)
 */
export function emptyOnTransientDbError(context: string) {
  return (err: unknown): never[] => {
    const code = (err as { code?: string } | null)?.code;
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient =
      code === "P2024" || // pool timeout
      code === "P1008" || // operations timed out
      /timeout|timed out|connection terminated|ETIMEDOUT/i.test(msg);
    if (!isTransient) throw err;
    console.error(
      `[explore] ${context} read failed (transient DB timeout) — rendering empty:`,
      msg,
    );
    return [];
  };
}
