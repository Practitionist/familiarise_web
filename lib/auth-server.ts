import { cache } from "react";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import {
  assertSessionReadMemoized,
  isSessionReadMemoized,
} from "@/lib/auth/session-read-guard";

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
 * Undeclared dependency: `react`'s version, and whether that matters
 * ------------------------------------------------------------------
 * package.json pins react ^18.3.1 and that build exports no `cache` —
 * verified in this checkout, not read off a changelog:
 *
 *   $ node -e "const r=require('react');
 *     console.log(r.version, typeof r.cache, Object.keys(r).includes('cache'))"
 *   18.3.1 undefined false
 *
 * It resolves anyway because Next aliases `react` to its own vendored React
 * 19 inside the RSC layer, and that build does export `cache`. So the memo
 * is real where it matters. The rest of the picture, including what happens
 * when it is NOT, is in lib/auth/session-read-guard.ts — that module is the
 * single source of truth for "is this read memoized", it reports the
 * unmemoized case to Sentry once per process, and `isSessionReadMemoized()`
 * below is what selects the reader. Do not re-derive the check here; the
 * tested value and the operational one must not be able to drift.
 */
type SessionReader = (
  disableCookieCache: boolean,
) => ReturnType<typeof auth.api.getSession>;

const readSession: SessionReader = async (disableCookieCache) =>
  auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });

/**
 * Report the memoization state at IMPORT time, not at first call.
 *
 * `sessionReader()` below would surface an unmemoized read on the first
 * getSession() — but a cron job that imports this file and exits without
 * ever reading a session (there are eight that do) would report nothing,
 * and that is exactly the case invisible from rendered output. Module scope
 * also means once per process rather than once per call. The call cannot
 * throw; see the guard's docblock for why that is a hard requirement given
 * this file sits in the import graph of every authenticated route and of
 * the payments/payouts reconciliation jobs.
 */
assertSessionReadMemoized();

/**
 * #1275 — built on FIRST CALL, not at module scope.
 *
 * The docblock above warned that losing Next's React alias would silently
 * degrade this to no memoization. The reality was worse: `cache(...)` at module
 * scope THREW, and it threw in every process that is not the RSC layer. Eight
 * scheduled jobs import this file transitively and every one of them died
 * during module evaluation, before a line of their own code ran:
 *
 *   $ npx tsx -e "import('./jobs/payments/reconcile-payment-status.ts')"
 *   IMPORT FAILS: (0 , import_react.cache) is not a function
 *
 * Those eight are the payments and payouts reconciliation layer, plus
 * `sweep-stuck-webhook-events` — which is the durability backstop the Stream
 * webhook route explicitly delegates to. None had ever completed a run.
 *
 * Deferring the call fixes the import; delegating the availability check to
 * `isSessionReadMemoized()` keeps the job. The unmemoized branch is the
 * correct behaviour in a one-shot cron process, not a degraded one —
 * memoization is meaningless there, because there is one request and nothing
 * to dedupe against. Inside a render nothing changes: the memo is built on
 * the first guard's call and every later guard in that render shares it.
 */
let memoizedReader: SessionReader | undefined;

function sessionReader(): SessionReader {
  memoizedReader ??= isSessionReadMemoized() ? cache(readSession) : readSession;
  return memoizedReader;
}

/**
 * A STAFF/ADMIN session without an enrolled second factor reads as NO session,
 * so the many routes that branch on `session.user.role` inline cannot hand
 * operator powers to a password-only sign-in. Only the enrolment path opts in
 * with `allowUnenrolledOperator`: `lookupSession`, behind the page guards
 * (which send the operator to /auth/two-factor/setup) and `requireApiAuth`
 * (which answers 428 rather than 401). BetterAuth's own /two-factor/*
 * endpoints read their session themselves and are unaffected.
 */
export async function getSession(
  disableCookieCache = false,
  { allowUnenrolledOperator = false } = {},
) {
  const session = await sessionReader()(disableCookieCache);
  return allowUnenrolledOperator ? session : withoutUnenrolledOperator(session);
}

function withoutUnenrolledOperator(
  session: Awaited<ReturnType<SessionReader>>,
) {
  const unenrolled =
    isOperatorRole(session?.user.role) &&
    session?.user.twoFactorEnabled !== true;
  return unenrolled ? null : session;
}

/**
 * Explicit cookie-cached session read for hot, cosmetic surfaces ONLY
 * (e.g. the #1697 busy/free availability grid, polled ~1/min/calendar).
 * Identical to `getSession()` with no arguments — the name exists so the
 * cached read is a deliberate, greppable choice rather than an omitted
 * argument, and so the `no-restricted-syntax` freshness rule in
 * eslint.config.mjs can ban the bare call without banning this one.
 *
 * The cookie cache is currently OFF (lib/auth.ts), so today this reads the
 * database like every other call. The split stays so re-enabling the cache
 * is a one-line change that cannot silently make a sensitive read stale:
 * PII, finance, documents, recordings and role-gated reads take
 * `getSession(true)` (or `requireApiAuth()` / `requireBackofficeSurface()`
 * in routes). See #1807.
 */
export async function getCachedSession() {
  return withoutUnenrolledOperator(await sessionReader()(false));
}
