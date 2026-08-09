/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Degrades ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is reported to Sentry (warning) so a recurrence of
 * the cold-query / schema-drift condition stays alertable. (#925, #929 review.)
 *
 * Fail-open applies only where the degraded result reaches the ONE request that
 * hit the failure. It is opt-in per call site via `perRequest`, and the default
 * is to rethrow — see {@link mayDegrade}.
 */
import * as Sentry from "@sentry/nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// A transient pooler failure during `next build` would bake an empty-but-valid
// page into static HTML and serve it to everyone for a whole revalidate window.
// Failing the build instead is loud, retryable, and costs nothing but a re-run.
// The build also gets a longer retry ladder than the request path. (#932)
//
// Next sets NEXT_PHASE to this constant for the duration of a production build
// (next/dist/build/index.js), and never at request time on the deployed server.
function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

export type FailOpenOptions = {
  /**
   * Set this ONLY where the render is genuinely per-request — a route that
   * exports `dynamic = "force-dynamic"`, or a Route Handler. Leave it unset on
   * anything with a `revalidate` export.
   */
  perRequest?: boolean;
};

// The build-phase guard was never the whole story. Since #1110 the explore
// routes are ISR, so a 200 carrying a degraded body is written to the Netlify
// durable cache and replayed to every visitor for the rest of the revalidate
// window — measured: one such render was served back at 0.3s with a climbing
// `age`, so the broken page became the FAST one and nothing looked wrong. Build
// output and the ISR cache are the same hazard: a render that is persisted and
// replayed must never carry a swallowed failure. Rethrowing instead costs the
// one unlucky visitor a 500, writes nothing to the cache, and leaves any
// previously cached good copy in place for everyone else. (#1119)
function mayDegrade(options?: FailOpenOptions): boolean {
  return Boolean(options?.perRequest) && !isProductionBuild();
}

// #932 was a COLD cross-region pooler connect, so the first attempt is far more
// likely to fail than the second. The build can afford a long ladder because the
// wall-clock is paid once per deploy rather than once per visitor.
const BUILD_RETRY_DELAYS_MS = [500, 2000];

// The request path now retries too, which the earlier build-only shape ruled out
// on the assumption that the first failure meant the pooler was unreachable.
// Measured on a preview (#1120): the connect that "timed out" was a casualty of a
// ~25s event-loop stall on a newly created instance, and the very next attempt
// connected in 327ms and 340ms. So the retry is close to free exactly when it
// fires, and it is what turns a degraded render back into a real one. One attempt
// only — a genuinely saturated pooler must still surface quickly. (#1119, #1120)
const REQUEST_RETRY_DELAYS_MS = [250];

/**
 * Retries a read on the transient-timeout class only. A mapper bug fails
 * identically every time and must surface immediately, so it is rethrown at once.
 *
 * The catch below rethrows everything non-transient on the spot, so Next's
 * control-flow signals (`notFound`, `redirect`) pass straight through and no
 * `unstable_rethrow` guard is needed — none of their messages can match the
 * transient regex.
 *
 * Safe to wrap a `React.cache`d reader: `cache` memoizes fulfilled results but
 * NOT a rejection, so the retry really re-runs the query rather than replaying the
 * failure. Verified against the React that Next 15.5.15 vendors
 * (19.2.0-canary-0bdb9206), both for a thrown error and a rejected promise.
 */
export async function withTransientRetry<T>(read: () => Promise<T>): Promise<T> {
  const delays = isProductionBuild()
    ? BUILD_RETRY_DELAYS_MS
    : REQUEST_RETRY_DELAYS_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastError = err;
      if (!isTransientDbError(err) || attempt === delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
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

export function emptyOnTransientDbError(
  context: string,
  options?: FailOpenOptions,
) {
  return (err: unknown): never[] => {
    if (!isTransientDbError(err)) throw err;
    if (!mayDegrade(options)) throw err;
    reportTransient(context, err);
    return [];
  };
}

/**
 * Object-shaped sibling of {@link emptyOnTransientDbError}: returns `fallback`
 * for the transient-timeout class and RETHROWS everything else. For a non-list
 * read on a `force-dynamic` route or a Route Handler whose response can still be
 * useful with a degraded value. It has no call site today — every former one was
 * on a route that is ISR now (#1119) — and is kept as the object-shaped half of
 * the pair rather than deleted and re-added at the next dynamic surface.
 */
export function fallbackOnTransientDbError<T>(
  context: string,
  fallback: T,
  options?: FailOpenOptions,
) {
  return (err: unknown): T => {
    if (!isTransientDbError(err)) throw err;
    if (!mayDegrade(options)) throw err;
    reportTransient(context, err);
    return fallback;
  };
}
