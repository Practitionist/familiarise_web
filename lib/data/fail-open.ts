/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Returns `[]` ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is reported to Sentry (warning) so a recurrence of
 * the cold-query / schema-drift condition stays alertable. (#925, #929 review.)
 *
 * Fail-open applies at REQUEST time only. During `next build` every helper here
 * rethrows, because a degraded render that gets prerendered is served to every
 * visitor until the next revalidation instead of just to the one request that hit
 * the timeout.
 */
import * as Sentry from "@sentry/nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Degrading is right at request time and wrong at build time. The public explore
// routes are prerendered during `next build`, so a transient pooler failure there
// would bake an empty-but-valid page into the static HTML and serve it to everyone
// for a whole revalidate window — a silent, uncatchable regression. Failing the
// build instead is loud, retryable, and costs nothing but a re-run. (#932)
//
// Next sets NEXT_PHASE to this constant for the duration of a production build
// (next/dist/build/index.js), and never at request time on the deployed server.
function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

// #932 was a COLD cross-region pooler connect, so the first attempt is far more
// likely to fail than the second. Retrying only during the build keeps request-path
// latency untouched while converting the most likely build failure into a success.
// Build-phase only, so the extra wall-clock is paid once per deploy, not per visitor.
const BUILD_RETRY_DELAYS_MS = [500, 2000];

/**
 * Wraps a read so it is retried during `next build` only. Returns the reader
 * untouched at request time — the fail-open path below already handles that case,
 * and a retry there would add latency to a page that is about to degrade anyway.
 */
export async function withBuildTimeRetry<T>(read: () => Promise<T>): Promise<T> {
  if (!isProductionBuild()) return read();

  let lastError: unknown;
  for (let attempt = 0; attempt <= BUILD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastError = err;
      // Only the transient class is worth retrying; a mapper bug fails identically
      // every time and should surface immediately.
      if (!isTransientDbError(err) || attempt === BUILD_RETRY_DELAYS_MS.length) {
        throw err;
      }
      console.warn(
        `[fail-open] transient DB error during build, retrying in ${BUILD_RETRY_DELAYS_MS[attempt]}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      await new Promise((r) => setTimeout(r, BUILD_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

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

// Report a degraded read without re-raising it: a server-log line plus a Sentry
// breadcrumb — NOT a captured event. The transient pooler-timeout class is a
// known, tracked condition (cross-region latency, #932), so firing a Sentry
// warning *issue* per degradation only floods the dashboard (and multiplies as
// more read paths adopt fail-open). The breadcrumb keeps the context attached to
// any *real* error captured later in the same request. (#929, #931, #934.)
export function reportTransient(
  context: string,
  err: unknown,
  tags?: Record<string, string>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[fail-open] ${context} (transient DB timeout) — degrading:`,
    message,
  );
  Sentry.addBreadcrumb({
    category: "fail-open",
    level: "warning",
    message: `${context} (transient DB timeout)`,
    data: { context, message, ...tags },
  });
}

export function emptyOnTransientDbError(context: string) {
  return (err: unknown): never[] => {
    if (!isTransientDbError(err)) throw err;
    // Never bake a degraded render into a prerendered page — see isProductionBuild.
    if (isProductionBuild()) throw err;
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
    // Never bake a degraded render into a prerendered page — see isProductionBuild.
    if (isProductionBuild()) throw err;
    reportTransient(context, err);
    return fallback;
  };
}
