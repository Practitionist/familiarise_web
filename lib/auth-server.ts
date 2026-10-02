import { cache } from "react";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/**
 * Render-memoized session read: nested layouts whose guards run in the same
 * RSC render share one getSession (and one customSession enrichment). Keyed by
 * disableCookieCache. Route Handlers and Server Actions get a fresh memo per
 * call, and a rejected read is re-thrown to every later guard in that render.
 *
 * `cache` exists only in the React build Next aliases into the RSC layer; the
 * package's own React 18 has none, so cron jobs that import this file fall back
 * to the plain reader (there is nothing to dedupe in a one-shot process).
 * Built on first call so importing never touches `cache` (#1275).
 */
type SessionReader = (
  disableCookieCache: boolean,
) => ReturnType<typeof auth.api.getSession>;

const readSession: SessionReader = async (disableCookieCache) =>
  auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });

let memoizedReader: SessionReader | undefined;

function sessionReader(): SessionReader {
  memoizedReader ??=
    typeof cache === "function" ? cache(readSession) : readSession;
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
