import { cache } from "react";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Render-memoized session read. Nested layouts that call requireOnboarded /
 * requireAuth in the same RSC render share one Better Auth getSession call
 * instead of re-running customSession enrichment for each guard. This is the
 * dedupe that actually cuts dashboard TTFB — the Better Auth cookie cache is
 * not, because customSession re-runs its Prisma work on every call anyway.
 *
 * Keyed by disableCookieCache so a force-fresh read never serves a cached
 * cookie-cache result (and vice versa) within the same request.
 *
 * Two limits worth knowing. React.cache memoizes only during an RSC render, so
 * Route Handlers and Server Actions get a throwaway cache per call and still
 * pay per getSession. And the memo holds the promise, so if the first read
 * rejects every later guard in that render re-throws the same rejection rather
 * than retrying independently (documented: react.dev/reference/react/cache).
 *
 * Undeclared dependency, deliberately recorded: package.json pins react
 * ^18.3.1, and react@18.3.1 does NOT export `cache` — `Object.keys(require(
 * "react")).includes("cache")` is false. This resolves only because Next
 * aliases `react` to its own vendored React 19 inside the RSC layer. It works
 * (the build is green and 5 pages plus lib/data already rely on it), but it
 * rests on a bundler alias rather than on the declared dep. If that alias ever
 * stops applying, this silently degrades to no memoization — correct results,
 * N times the queries, and no test would catch it. Revisit when React 19
 * lands properly; Next 15's App Router targets it.
 */
const getSessionCached = cache(async (disableCookieCache: boolean) => {
  return auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });
});

export async function getSession(disableCookieCache = false) {
  return getSessionCached(disableCookieCache);
}
