/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Returns `[]` ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is reported to Sentry (warning) so a recurrence of
 * the cold-query / schema-drift condition stays alertable. (#925, #929 review.)
 */
import * as Sentry from "@sentry/nextjs";

// Exported so non-explore read paths (e.g. the public announcements banner) can
// share the same transient-class detection and degrade rather than 500 (#929).
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === "P2024" || // pool timeout
    code === "P1008" || // operations timed out
    /timeout|timed out|connection terminated|ETIMEDOUT/i.test(msg)
  );
}

// Report a degraded read without re-raising it: a console line for local/server
// log visibility + a structured Sentry warning carrying the underlying error
// message, so the fail-open path stays observable rather than silent. Shared by
// the explore reads and other public read paths (e.g. announcements). (#929, #931.)
export function reportTransient(
  context: string,
  err: unknown,
  tags?: Record<string, string>,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[fail-open] ${context} (transient DB timeout) — degrading:`,
    msg,
  );
  Sentry.captureMessage(`fail-open: ${context} (transient DB timeout)`, {
    level: "warning",
    extra: { context, message: msg },
    ...(tags ? { tags } : {}),
  });
}

export function emptyOnTransientDbError(context: string) {
  return (err: unknown): never[] => {
    if (!isTransientDbError(err)) throw err;
    reportTransient(context, err);
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
    reportTransient(context, err);
    return fallback;
  };
}
