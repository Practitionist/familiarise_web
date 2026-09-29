/**
 * The client half of "degrade toward a second line, not toward open".
 *
 * ## What the user is told, and why it is not a catalog code
 *
 * This is a **status**, not a failure: the sign-in form still works, the
 * password is still checked, nothing has been refused. The catalog
 * (`lib/labels/auth-errors.catalog.ts`) is a `Record<AuthErrorCode, …>` over a
 * closed union, and a new code needs a member in `AppAuthErrorCode`
 * (`lib/labels/auth-error-codes.ts`) before the catalog row can exist — neither
 * of which is this change's to edit. So the sentence is written here, and it is
 * written to be *reassuring*: the other three banners on the sign-in page
 * (`isPurchaseReturn`, `wasRevokedElsewhere`, `needsVerification`) are all
 * hand-written for the same reason, so the file is consistent rather than
 * special.
 *
 * What it deliberately does NOT say: anything about the customer being suspect,
 * and anything about the limiter. A degraded store is our problem, the form
 * still works, and saying "sign-in protection is temporarily reduced" on a login
 * page is the sort of sentence that makes a person abandon checkout.
 *
 * ## What it is wired to
 *
 * `RATE_LIMIT_DEGRADED_HEADER`, stamped on the request by `middleware.ts` and
 * echoed onto the response by `/api/auth/sso/domain-check` — see
 * `lib/auth/degraded-captcha.ts` for the server half and why the value is
 * copied rather than computed.
 */

/**
 * Mirrors `RATE_LIMIT_DEGRADED_HEADER` in `lib/rate-limit.ts` and the two
 * copies in `lib/auth/degraded-captcha.ts` and the domain-check route. Three
 * literals, one contract, and `__tests__/auth/degraded-captcha.test.ts` asserts
 * all of them against the exported constant. Read the comment there before
 * adding a fourth.
 */
export const DEGRADED_HEADER = "x-rate-limit-degraded";

/** True when a response says the auth surface is running with no rate limiter. */
export function isDegradedResponse(response: Response): boolean {
  return response.headers.get(DEGRADED_HEADER) === "1";
}

export const DEGRADED_BANNER = {
  title: "Sign-in is working normally",
  description:
    "Our extra protection against automated sign-in attempts is temporarily " +
    "unavailable, so we have switched on an extra check instead. It is not " +
    "anything you did — please continue.",
} as const;
