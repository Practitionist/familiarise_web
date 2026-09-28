/**
 * Better Auth `hooks.before` / `hooks.after` for credential sign-in: the
 * per-account lockout gate, the failure counter, and the disclosure verdict.
 *
 * ## Why hooks and not `databaseHooks`
 *
 * `databaseHooks` fire inside BetterAuth's internal user/account/session
 * operations, which is the wrong altitude. By the time a `session.create`
 * hook runs, the password has already been compared *and* the session written;
 * refusing there would leave an orphan `Session` row per locked-out attempt,
 * and would make the session cap (#1857) count attempts that never happened.
 * A `hooks.before` on `/sign-in/email` runs before the handler and can
 * short-circuit the whole request.
 *
 * ## How the short-circuit works (verified, not assumed)
 *
 * `runBeforeHooks` (`better-auth/dist/api/to-auth-endpoints.mjs:144`) returns a
 * hook's result directly when it is an object *without* a `context` key
 * (`:180`), and the endpoint wrapper at `:88` returns it as the response. So
 * returning a `Response` from a before hook ends the request. (This is the
 * documented alternative to throwing: an `APIError` thrown from a router
 * middleware is swallowed as an unexpected error — better-auth PR #957.)
 *
 * The after hook is the mirror image: it runs at `:116`, *after*
 * `context.returned` is set at `:114` and *after* the handler's `.catch()` at
 * `:100` has converted a thrown `APIError` into the result. So a failed
 * sign-in is observable as an `APIError` on `ctx.context.returned`, and
 * rethrowing from the after hook is converted back into a response at `:196`.
 *
 * ## Why the disclosure rides on a header, not on the error body
 *
 * The tempting design is to rewrite the 401 body to say "no such account".
 * It does not survive contact with BetterAuth: `isAPIError(result.response)`
 * at `:119` decides whether the response is *thrown* or *returned*, so
 * replacing the `APIError` with a plain object turns a 401 into a 200. The
 * value can be attached to the error, but then it is the plugin's serialiser
 * that decides whether it reaches the wire.
 *
 * A response header is unconditional: `runAfterHooks` merges `result.headers`
 * into `context.responseHeaders` (`:203`) regardless of the body's type, and
 * the client already has an `onResponse` hook to read it (see
 * `components/auth/useRetryAfterCapture.ts`, which reads `Retry-After` the same
 * way). The verdict therefore arrives on the same channel as the honest wait
 * time, and the page's `humanizeAuthError(flow, err, { disclosure })` call is
 * unchanged.
 *
 * ## What is *not* here
 *
 * The `recordSignInFailure` call is deliberately confined to the one branch
 * where the credentials were actually wrong. Counting a captcha rejection, a
 * rate-limit refusal, a `REQUIRE_EMAIL_VERIFICATION` bounce or a validation
 * error as a "failed password" would hand an attacker who cannot authenticate
 * at all a denial of service against real customers.
 */

import { createAuthMiddleware } from "better-auth/api";
import { APIError } from "better-auth/api";

import {
  clearSignInAttempts,
  readSignInAttempt,
  recordSignInFailure,
  type SignInAttemptVerdict,
} from "@/lib/auth/attempts";
import { classifyAccountState } from "@/lib/auth/attempts";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import prisma from "@/lib/prisma";

/** BetterAuth's credential endpoint. Verified in `dist/api/routes/sign-in.mjs`. */
const SIGN_IN_EMAIL = "/sign-in/email";

/** Matches the limiter scope in `lib/rate-limit/policies.ts`. */
const RATE_SCOPE = "auth.sign-in";

/**
 * Headers the sign-in page reads. Namespaced so they cannot collide with
 * anything BetterAuth sets, and stable so a page can rely on them.
 */
const HEADER_ATTEMPTS = "x-auth-attempts";
const HEADER_DISCLOSURE = "x-auth-disclosure";
const HEADER_ACCOUNT_STATE = "x-auth-account-state";

/** `humanizeAuthError` reveals the specific sentence only at or past this. */
const DISCLOSURE_UNLOCK_AFTER = 3;

function emailFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  // A shape this thin is not a real address; spending a Redis round trip and a
  // counter increment on it would let a caller write arbitrary keys.
  if (!trimmed || trimmed.length > 320 || !trimmed.includes("@")) return null;
  return trimmed;
}

function verdictHeaders(verdict: SignInAttemptVerdict): Headers {
  const headers = new Headers();
  headers.set(HEADER_ATTEMPTS, String(verdict.disclosure.attempts));
  if (verdict.disclosure.unlocked) headers.set(HEADER_DISCLOSURE, "1");
  return headers;
}

function lockedResponse(verdict: SignInAttemptVerdict): Response {
  const seconds = verdict.retryAfterSeconds ?? 1;
  return new Response(
    JSON.stringify({
      error: "Too many failed sign-in attempts for this account.",
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      scope: RATE_SCOPE,
      retryAfterSeconds: seconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(seconds),
        "X-RateLimit-Scope": RATE_SCOPE,
        ...Object.fromEntries(verdictHeaders(verdict)),
      },
    },
  );
}

/**
 * Classify the account, for the specific copy.
 *
 * Runs only once disclosure has unlocked — see the module header. The
 * `hasAccount` probe is one indexed read against `accounts`; the `enforceSSO`
 * probe is the same `lookupEnforcedOrg` the session-creation veto uses, so the
 * two answers cannot disagree about whether a domain is SSO-enforced.
 */
async function describeAccount(email: string): Promise<string> {
  try {
    const [user, account, enforcedOrg] = await Promise.all([
      prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, emailVerified: true, banned: true },
      }),
      prisma.account.findFirst({
        where: { user: { email: email.toLowerCase() }, providerId: "credential" },
        select: { id: true },
      }),
      lookupEnforcedOrg(prisma, email.split("@")[1] ?? ""),
    ]);

    return classifyAccountState({
      user,
      hasPassword: account !== null,
      ssoEnforced: enforcedOrg !== null,
    });
  } catch {
    // A database fault must not turn a wrong password into an account
    // disclosure — and must not turn sign-in into a 500 either. "unknown"
    // degrades to the collapsed sentence, which is the safe direction.
    return "unknown";
  }
}

/**
 * The gate. Refuses a locked account before the password is ever compared.
 *
 * A read, not a write, so calling it on every request to a sign-in-shaped
 * route cannot itself be turned into a counter an attacker can inflate.
 */
export const signInAttemptBeforeHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== SIGN_IN_EMAIL) return;

  const email = emailFromBody(ctx.body);
  if (!email) return;

  const verdict = await readSignInAttempt(email);
  if (!verdict.lockedUntil) {
    // Not locked: publish the current count so the page can decide, but do not
    // return anything — an object carrying `context` would *merge* into the
    // request rather than short-circuit, and a bare `Response` here would end a
    // request that should proceed.
    const headers = ctx.headers;
    for (const [k, v] of verdictHeaders(verdict)) headers?.set(k, v);
    return;
  }

  return lockedResponse(verdict);
});

/**
 * The counter, the disclosure, and the attempt that trips the lockout.
 *
 * BetterAuth's sign-in answers a wrong password, an unknown address and an
 * SSO-only account with the same `APIError`, so `returned instanceof APIError`
 * alone cannot tell a credential failure from a rate-limit refusal. The code
 * is the discriminator, and the allowlist is short on purpose.
 */
export const signInAttemptAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== SIGN_IN_EMAIL) return;

  const email = emailFromBody(ctx.body);
  if (!email) return;

  const returned = ctx.context.returned;

  /* Success: the counters are now spent. */
  if (returned && !(returned instanceof APIError)) {
    await clearSignInAttempts(email);
    return;
  }

  /* Failure: only a real credential rejection counts. */
  if (!(returned instanceof APIError)) return;
  const code = (returned.body as { code?: unknown } | undefined)?.code;
  if (code !== "INVALID_EMAIL_OR_PASSWORD" && code !== "INVALID_PASSWORD") {
    return;
  }

  const verdict = await recordSignInFailure(email);
  const headers = verdictHeaders(verdict);

  if (verdict.lockedUntil) {
    // The attempt that crosses the threshold is itself refused. Letting it
    // succeed and only *then* reporting a lockout would hand a credential
    // staller one last authenticated session for free — and the customer would
    // learn about the lockout from the *next* failure rather than from the
    // one that caused it.
    headers.set("Retry-After", String(verdict.retryAfterSeconds ?? 1));
    headers.set("X-RateLimit-Scope", RATE_SCOPE);
    throw new APIError("TOO_MANY_REQUESTS", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Too many failed sign-in attempts for this account.",
      headers: Object.fromEntries(headers),
    });
  }

  if (verdict.disclosure.attempts >= DISCLOSURE_UNLOCK_AFTER) {
    headers.set(HEADER_ACCOUNT_STATE, await describeAccount(email));
  }

  // The verdict travels on headers; the error body stays BetterAuth's, so
  // `isAPIError(result.response)` at to-auth-endpoints.mjs:119 is unaffected
  // and the 401 is still thrown. See the module header.
  for (const [k, v] of headers) ctx.context.responseHeaders?.set(k, v);
  if (!ctx.context.responseHeaders) {
    ctx.context.responseHeaders = new Headers(Object.fromEntries(headers));
  }
});
