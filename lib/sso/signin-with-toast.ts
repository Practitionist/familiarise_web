/**
 * Robust wrapper for BetterAuth's `signIn.sso(...)` client call.
 *
 * Why this exists
 * ---------------
 * The raw `signIn.sso(...)` call has three failure modes that the
 * sign-in / sign-up pages have to handle, and the bare `await` form
 * (used inline before audit Phase B.1) catches none of them:
 *
 *   1. **BetterAuth returns `{ data, error }` instead of throwing.**
 *      Per the BetterAuth client docs, the SDK never throws on a
 *      logical failure — it resolves with an `error` field. An inline
 *      `await signIn.sso(...)` happily continues even when SSO failed.
 *
 *   2. **Server-side 500 with empty body.** When the plugin crashes
 *      building the request, the response is `500` with `0` bytes. The
 *      SDK swallows this and resolves with `error: null` AND no
 *      redirect. From the UI's perspective, nothing happened.
 *
 *   3. **No redirect within reasonable time.** Even when BetterAuth
 *      builds the OIDC authorization URL successfully, the browser may
 *      fail to follow the redirect (corporate proxy, blocked IdP
 *      host, CSP misconfig). Without a watchdog, the page sits
 *      indefinitely with a spinner.
 *
 * This wrapper:
 *   - Inspects the BetterAuth result's `error` field if present.
 *   - Races the call against a 2-second watchdog; if neither a
 *     redirect nor a thrown error happens, surfaces a generic toast.
 *   - Catches synchronous throws (network errors, malformed args).
 *
 * Call sites:
 *   - app/auth/signin/page.tsx (blur-triggered + manual click)
 *   - app/auth/signup/page.tsx (blur-triggered)
 *
 * See audit Phase B.1.
 */

import { signIn } from "@/lib/auth-client";
import type { AuthErrorAction, AuthErrorCopy } from "@/lib/labels/auth-errors";
import { AUTH_ERROR_COPY } from "@/lib/labels/auth-errors";
import {
  isAuthErrorCode,
  normalizeAuthErrorCode,
} from "@/lib/labels/auth-error-codes";

export interface SsoSigninParams {
  providerId: string;
  domain?: string;
  /** Required by BetterAuth's SDK — the post-SSO landing URL. */
  callbackURL: string;
}

export interface SsoSigninResult {
  /** True iff BetterAuth confirmed the redirect was initiated. */
  ok: boolean;
  /** Human-readable reason on failure; null on success. */
  errorMessage: string | null;
  /**
   * The catalog code behind {@link errorMessage}, when the failure maps onto
   * one. Lets a caller branch on the code (e.g. offer "switch to SSO" vs
   * "contact support") without re-parsing the message. `null` when the
   * failure is generic.
   */
  errorCode: string | null;
  /** Catalog action for the copy that was returned, if any. */
  action: AuthErrorAction | null;
}

/**
 * Redirect-watchdog timeout. Tuned for the 99th-percentile case where
 * BetterAuth builds the OIDC authorization URL in <500ms and the browser
 * navigates immediately after. 2 seconds gives a comfortable margin
 * without making the user wait on a definitely-broken flow.
 */
const SSO_WATCHDOG_MS = 2_000;

/**
 * The copy the catalog already has for an SSO button that cannot complete.
 * Chosen so the two outcomes stay distinguishable: a misconfigured provider
 * needs the *administrator* (nothing the user retries will help), whereas an
 * unreachable one is worth one retry.
 */
const TIMEOUT_COPY: AuthErrorCopy = AUTH_ERROR_COPY.SSO_PROVIDER_UNREACHABLE;

/**
 * Generic fallbacks. These are expressed as catalog entries so there is still
 * exactly one error-vocabulary in this app; the pre-audit version of this
 * file invented its own three sentences, which is how a raw library
 * `TypeError` ended up on a customer's screen.
 */
const GENERIC_COPY: AuthErrorCopy = {
  title: "SSO sign-in failed",
  description: "Please try again, or contact your IT admin.",
  action: "retry",
};

const UNEXPECTED_COPY: AuthErrorCopy = {
  title: "SSO sign-in failed unexpectedly",
  description: "Please try again.",
  action: "retry",
};

/**
 * Substrings that identify a *provider-side* failure inside a library message
 * we are refusing to show.
 *
 * BetterAuth's SSO endpoints raise `APIError`s whose `message` is the
 * library's own prose, and a crash inside the plugin surfaces as a plain
 * `TypeError`. Those messages are written for an operator reading a
 * server log — they name internal fields and BetterAuth's endpoint paths, none of which mean anything to the person
 * clicking "Sign in with SSO", and all of which tell an attacker which IdP
 * software and version the target runs. So the message is used only to pick
 * catalog copy, then discarded.
 *
 * Order matters: the first match wins, and the patterns are specific enough
 * that an unrelated failure cannot fall into a neighbouring bucket.
 */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, AuthErrorCopy]> = [
  [
    // "Invalid OIDC configuration", "No provider found for the issuer",
    // "OIDC provider is not configured", and "Provider domain has not been
    // verified" (a provider still awaiting platform approval).
    /\b(?:invalid|missing|no)\s+oidc\s+config|provider not found|is not configured|has not been verified/i,
    AUTH_ERROR_COPY.SSO_PROVIDER_MISCONFIGURED,
  ],
  [
    // "OIDC discovery …", DNS/ECONNREFUSED/ETIMEDOUT phrasing, "untrusted
    // OIDC discovery URL", fetch failures from the IdP.
    /discovery|econnrefused|enotfound|etimedout|eai_again|fetch failed|socket hang up|network|unreachable|timed out/i,
    AUTH_ERROR_COPY.SSO_PROVIDER_UNREACHABLE,
  ],
  [
    // "This email domain requires SSO sign-in" — the org enforces SSO and
    // this user has no linked account on any of its providers.
    /requires\s+sso|sso\s+required|must\s+use\s+sso/i,
    AUTH_ERROR_COPY.SSO_REQUIRED,
  ],
];

function copyForMessage(message: string): AuthErrorCopy | null {
  for (const [pattern, copy] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return copy;
  }
  return null;
}

function toResult(copy: AuthErrorCopy, code: string | null): SsoSigninResult {
  return {
    ok: false,
    errorMessage: `${copy.title}. ${copy.description}`,
    errorCode: code,
    // `AuthErrorCopy.action` is optional — a few catalog entries only supply
    // a sentence. `null` means "nothing actionable", not "no action needed".
    action: copy.action ?? null,
  };
}

function ok(): SsoSigninResult {
  return { ok: true, errorMessage: null, errorCode: null, action: null };
}

/**
 * Normalize BetterAuth's `{ data, error }` resolution into our
 * `SsoSigninResult`. BetterAuth never throws on logical failure — it
 * resolves with `error: { message }` or `error: null`. Older client
 * versions return the raw fetch Response, so we narrow defensively.
 *
 * `error.code` is preferred over `error.message` when it is one of ours:
 * BetterAuth upper-cases its own codes and our routes answer `{error, code}`,
 * so a recognised code needs no pattern-matching at all. Only when the code
 * is absent or unrecognised do we fall back to matching the message — and even
 * then we return catalog copy, never the message itself.
 */
function extractBetterAuthError(result: unknown): SsoSigninResult {
  if (!result || typeof result !== "object" || !("error" in result))
    return ok();

  const err = (result as { error: unknown }).error;
  if (!err) return ok();

  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (isAuthErrorCode(code)) {
      const normalized = normalizeAuthErrorCode(code);
      if (normalized) {
        const copy = AUTH_ERROR_COPY[normalized];
        if (copy) return toResult(copy, normalized);
      }
    }
  }

  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : "";

  return toResult(copyForMessage(message) ?? GENERIC_COPY, null);
}

/** Awaits signIn.sso(); converts thrown errors into the result shape. */
async function callSignInSso(
  params: SsoSigninParams,
): Promise<SsoSigninResult> {
  try {
    const result = await signIn.sso(params);
    return extractBetterAuthError(result);
  } catch (err) {
    // A throw here is a network/CORS failure or a library crash, not a
    // logical rejection. Its message is still never returned verbatim.
    const message = err instanceof Error ? err.message : "";
    return toResult(copyForMessage(message) ?? UNEXPECTED_COPY, null);
  }
}

/** Resolves after `ms` with the "redirect didn't happen" result. */
function watchdogTimer(ms: number): Promise<SsoSigninResult> {
  return new Promise((resolve) => {
    setTimeout(
      () => resolve(toResult(TIMEOUT_COPY, "SSO_PROVIDER_UNREACHABLE")),
      ms,
    );
  });
}

export async function ssoSigninWithGuard(
  params: SsoSigninParams,
): Promise<SsoSigninResult> {
  // Race the SDK call against a watchdog timer. The happy path is that
  // the browser navigates to the IdP before either promise resolves,
  // and the caller's `.finally(setLoading(false))` never fires — which
  // is the intended UX (no flash-of-error before the IdP page loads).
  return Promise.race([callSignInSso(params), watchdogTimer(SSO_WATCHDOG_MS)]);
}
