/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Returns `[]` ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is logged for observability. (#925 review.)
 */
function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === "P2024" || // pool timeout
    code === "P1008" || // operations timed out
    /timeout|timed out|connection terminated|ETIMEDOUT/i.test(msg)
  );
}

export function emptyOnTransientDbError(context: string) {
  return (err: unknown): never[] => {
    if (!isTransientDbError(err)) throw err;
    console.error(
      `[explore] ${context} read failed (transient DB timeout) — rendering empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  };
}

/**
 * Object-shaped sibling of {@link emptyOnTransientDbError}: returns `fallback`
 * for the transient-timeout class and RETHROWS everything else. For non-list
 * reads whose page can still render with a degraded value — the experts-page
 * metadata bundle (empty filters + marketing hero defaults) or a detail page's
 * `generateMetadata` (a generic title beats a 500 with no error boundary).
 */
export function fallbackOnTransientDbError<T>(context: string, fallback: T) {
  return (err: unknown): T => {
    if (!isTransientDbError(err)) throw err;
    console.error(
      `[explore] ${context} read failed (transient DB timeout) — using fallback:`,
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  };
}
