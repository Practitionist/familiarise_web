/**
 * Degrade toward a captcha, not toward open, when the limiter's Redis is
 * unreachable.
 *
 * ## The gap this closes
 *
 * Failure-modes row 1: `applyRateLimit` fails **open** when the limiter store
 * throws, and that fail-open is correct — a Redis outage must not log every
 * paying customer out of their own account. What it leaves behind is a *silent*
 * hole on exactly the credential endpoints where the human at the keyboard is
 * the last remaining line. `RATE_LIMIT_DEGRADED_HEADER` was shipped with that
 * sentence in its docblock and had no consumer; this is the consumer.
 *
 * ## Why the header, not `isRateLimitDegraded()`
 *
 * `isRateLimitDegraded()` is a module-level flag in `lib/rate-limit.ts`, and
 * edge middleware and a route handler are **separate isolates with separate
 * module graphs** — so a flag set in the middleware is always `false` in here.
 * A gate that read the predicate would be deaf to precisely the outage it
 * exists for, which is the bug the header's docblock warns about. Everything
 * below therefore reads the **request header** that `middleware.ts` stamps, and
 * the constant is duplicated rather than imported — see the note on
 * `DEGRADED_HEADER`.
 *
 * ## Why the plugin's own verifier, called by hand
 *
 * The `captcha` plugin's `endpoints` list is static (it is read at plugin
 * construction), so "require a captcha *only while degraded*" cannot be
 * expressed by configuring it — and `lib/auth.ts` is not this change's to edit.
 * What *is* available is the plugin object itself: `captcha({...})` returns
 * `{ onRequest, options, … }`, and `onRequest` is the whole gate — the
 * `x-captcha-response` presence test, the siteverify round trip, the
 * `MISSING_RESPONSE` / `VERIFICATION_FAILED` / 500 envelope. So this module
 * builds a second instance over a different `endpoints` list and calls its
 * `onRequest` with the live request.
 *
 * That is deliberately *not* a hand-rolled `POST .../siteverify`. The
 * `lib/sso/oidc-discovery.ts` header records the rule this repo already applies
 * to a library that does a job we could re-implement: call the library's own
 * pipeline, so an upgrade cannot leave us running a divergent copy of its
 * verification. A second `cloudflareTurnstile` implementation would be exactly
 * that divergence, and it would be the copy nobody tests.
 *
 * ## What is escalated, and why only this
 *
 * The plugin's static list already covers the five endpoints an attacker
 * scripts: sign-in (email, social, SSO), sign-up and the reset request. Under
 * degradation those five lose nothing — they were captcha-gated before the
 * outage and stay captcha-gated through it. So the escalation cannot be "turn
 * on the captcha"; it can only be "add the endpoint that had *nothing* in front
 * of it".
 *
 * That endpoint is `/send-verification-email`. It is unauthenticated, it is a
 * POST that mails an arbitrary address, and its only budget is
 * `RATE_POLICIES[AUTH_SEND_VERIFICATION]` — ip 10/hr, account 3/hr — both of
 * which fail open while Redis is unreachable. A degraded limiter therefore turns
 * a 3-an-hour button into an unlimited mail trigger at our sending reputation
 * and our bounce rate, on a request that costs one unauthenticated POST. It is
 * also the one endpoint in the set a page we own calls, so a real customer can
 * actually satisfy the challenge the escalation demands.
 *
 * Deliberately *not* escalated: `/reset-password` and `/verify-email`, whose
 * budgets are keyed on the token/secret itself and stay meaningful without Redis
 * because the secret is the limiter. And `/sign-in/sso` is excluded from
 * consideration entirely because the plugin already owns it.
 *
 * ## The honest answer when the feature is off
 *
 * `captcha` is registered in `lib/auth.ts` only when `TURNSTILE_SECRET_KEY` is
 * set, and there is no such thing as a mandatory captcha that nobody can
 * produce. Requiring `x-captcha-response` with no widget and no secret would
 * answer `400 MISSING_RESPONSE` to every verification resend for the whole
 * deployment — a self-inflicted outage, which is the exact failure this design
 * exists to avoid. So with no secret this is a no-op, and the "log louder" half
 * is the whole deliverable: a throttled, marked report on every degraded
 * verification request saying the protection was unavailable. That is a
 * deliberate decision, not an unfinished one — and it is the reason the item is
 * safe to land while the secret is unset.
 */

import { captcha } from "better-auth/plugins";

import { markExpected } from "@/lib/observability/expected";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/**
 * The header `middleware.ts` stamps on the request when the limiter store was
 * unreachable. Mirrors `RATE_LIMIT_DEGRADED_HEADER` in `lib/rate-limit.ts`.
 *
 * Declared here rather than imported, and the tension is real so it is stated:
 * the one-constant-one-declaration rule would say import it. The counter is
 * bundle and cold-start, and cold start on the auth path is this repo's most
 * measured problem (failure-modes row 6: a 25–28 s stall before any application
 * code runs). `lib/rate-limit.ts` constructs ~50 `Ratelimit` instances at module
 * scope and imports `next/server`; pulling it into `lib/auth.ts`'s graph to save
 * one string literal trades a correctness risk for a performance risk, and the
 * performance risk is the one that actually pages someone.
 *
 * The guarantee is kept by test instead of by import:
 * `__tests__/auth/degraded-captcha.test.ts` asserts this equals the exported
 * constant, so the two cannot drift silently. If that assertion is ever deleted
 * rather than the duplication, this comment is the thing to re-read.
 */
const DEGRADED_HEADER = "x-rate-limit-degraded";

/**
 * Endpoints that gain a mandatory captcha while the limiter store is down.
 *
 * Passed to the plugin as `endpoints`, which it matches with
 * `request.url.includes(endpoint)` — a substring test on the full URL, not an
 * exact-path test. `/send-verification-email` is distinctive enough that the
 * difference cannot bite, but a future entry must be a full path segment and
 * not a prefix: this is the `/forget-password` footgun's sibling, in the plugin
 * rather than in our own matcher.
 */
const DEGRADED_CAPTCHA_ENDPOINTS = ["/send-verification-email"];

/** The plugin's own 500, which means the verifier itself did not answer. */
const VERIFIER_UNAVAILABLE = 500;

type CaptchaPlugin = ReturnType<typeof captcha>;

/**
 * The context the plugin's `onRequest` expects, derived from the plugin rather
 * than imported from `@better-auth/core`.
 *
 * That is deliberate: `@better-auth/core` is a transitive dependency, and the
 * plugin's own signature is the thing we must satisfy, so deriving it means a
 * core upgrade cannot leave this file holding a stale shape.
 */
type CaptchaContext = Parameters<CaptchaPlugin["onRequest"]>[1];

/**
 * A second instance of the plugin, scoped to the escalation endpoints only.
 *
 * Built lazily and memoised: constructing it is free (it is a closure factory),
 * but the alternative — building one per request — would make a reviewer
 * wonder whether the plugin registers routes, and it does not. `undefined` when
 * the deployment has no secret, which is the documented no-op.
 */
let escalation: CaptchaPlugin | undefined;
let escalationBuilt = false;

function escalationPlugin(): CaptchaPlugin | undefined {
  if (escalationBuilt) return escalation;
  escalationBuilt = true;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) return undefined;
  escalation = captcha({
    provider: "cloudflare-turnstile",
    secretKey,
    endpoints: DEGRADED_CAPTCHA_ENDPOINTS,
  });
  return escalation;
}

/** Test-only: forget the memoised instance so a changed env var is re-read. */
export function resetDegradedCaptchaForTesting(): void {
  escalation = undefined;
  escalationBuilt = false;
}

/** True when this request is carrying the edge's degradation flag. */
export function isDegradedRequest(headers: Headers | undefined): boolean {
  return headers?.get(DEGRADED_HEADER) === "1";
}

/**
 * The gate. Returns a `Response` to answer the request with, or `null` to let
 * it through.
 *
 * A `Response` returned from a `hooks.before` middleware ends the request — the
 * same short-circuit `lib/auth/sign-in-attempt-hooks.ts` already relies on for
 * the lockout, verified against `runBeforeHooks`
 * (`better-auth/dist/api/to-auth-endpoints.mjs:144`).
 *
 * `authContext` is the live `ctx.context`, passed straight through so the
 * plugin's `getIp` and `logger` are the real ones. It is a parameter rather than
 * a module import so this stays unit-testable without constructing a whole
 * Better Auth instance.
 */
export async function degradedCaptchaRefusal(args: {
  path: string;
  headers: Headers | undefined;
  request: Request | undefined;
  authContext: CaptchaContext;
}): Promise<Response | null> {
  const { path, headers, request, authContext } = args;

  if (!isDegradedRequest(headers)) return null;
  if (!DEGRADED_CAPTCHA_ENDPOINTS.some((e) => path.includes(e))) return null;

  const plugin = escalationPlugin();
  if (!plugin) {
    // Nothing to escalate to. The outage is real and the protection is absent,
    // so say so — once a minute per instance, marked expected, because a
    // deployment with no Turnstile secret is a deliberate configuration and not
    // a fault to page about. The event is the deliverable here: without it,
    // "degraded" and "no bot protection at all" look identical from outside.
    reportUnavailable("degradedCaptcha:noSecret");
    return null;
  }

  // The plugin reads `request.url` and `request.headers` and nothing else, so
  // the real request is used when better-call provides one and a URL-only stand-in
  // is built when it does not. `better-call` types `request` as optional
  // (`EndpointContext`, `context.d.mts:89`), so the fallback is not dead code.
  const probe =
    request ??
    new Request(`https://auth.internal.invalid/api/auth${path}`, { headers });

  const verdict = await plugin.onRequest(probe, authContext);
  if (!verdict) return null;

  const { response } = verdict;
  if (response.status === VERIFIER_UNAVAILABLE) {
    // The verifier did not answer. Fail **open** here for the same reason
    // `applyRateLimit` does: Cloudflare being down must not stop customers
    // resending a verification mail, and a bot getting through a degraded
    // window is a far smaller loss than an outage during a Redis incident.
    // Reported, because "we are unprotected right now for a second reason" is
    // the sentence an operator needs.
    reportUnavailable("degradedCaptcha:verifierUnavailable");
    return null;
  }

  // The refusal itself is a modelled answer — a 400/403 with a typed
  // `MISSING_RESPONSE` / `VERIFICATION_FAILED` code the catalog already has copy
  // for. The degraded header is echoed on the *response* so the page can explain
  // why a captcha is suddenly required (see
  // `app/api/auth/sso/domain-check/route.ts` for the other half).
  response.headers.set(DEGRADED_HEADER, "1");
  return response;
}

/**
 * "We are degraded and there is no captcha to fall back on", throttled and
 * marked. `reason` names which of the two unavailable-capability cases it is.
 */
function reportUnavailable(reason: string): void {
  const error = markExpected(
    new Error("rate limit store unreachable and no captcha available"),
  );
  captureThrottled(`auth/degraded-captcha:${reason}`, error, {
    subsystem: "auth",
    op: reason,
    expected: true,
    level: "warning",
  });
}
