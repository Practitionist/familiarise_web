# Auth errors: what a customer is told

| Field         | Value                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                               |
| Audience      | Engineers changing auth pages or minting auth refusals                                             |
| Last reviewed | 2026-10-01                                                                                         |
| Source        | `lib/labels/auth-error-codes.ts`, `lib/labels/auth-errors.catalog.ts`, `lib/labels/auth-errors.ts` |

## 1. The rules

1. **Sign-in failures are generic.** A wrong email and a wrong password both
   answer `INVALID_EMAIL_OR_PASSWORD`. Forgot-password answers the same way
   for known and unknown addresses. No response, header or timing branch tells
   a caller whether an account exists.
2. **The server's message is never shown.** BetterAuth's messages are written
   for developers. `humanizeAuthError` maps a code or a status to our own copy
   and never echoes `error.message`.
3. **The set of codes is closed.** A code we render must be in
   `AuthErrorCode`, and the catalog is a `Record` over that union, so a missing
   sentence fails `tsc`.

## 2. The union

`AuthErrorCode = BetterAuthErrorCode | AppAuthErrorCode`
(`lib/labels/auth-error-codes.ts`).

- **`BetterAuthErrorCode`**: the codes a customer can reach through our UI,
  taken from the installed package (core `BASE_ERROR_CODES`, the admin plugin's
  `BANNED_USER`, the twoFactor plugin's codes) and checked against
  `auth.$ERROR_CODES`. A code that an upgrade renames, or a removed plugin takes
  away, fails the build. Back-office authorization codes
  (`YOU_ARE_NOT_ALLOWED_*`) are left out on purpose.
- **`AppAuthErrorCode`**: codes this codebase mints.

| Code                                                                    | Minted by                                                                                   | Status             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| `PASSWORD_COMPROMISED`                                                  | `lib/auth/password-policy.ts` (HIBP)                                                        | 400                |
| `SSO_REQUIRED`                                                          | `session.create.before` SSO veto                                                            | 403                |
| `STAFF_PASSWORD_SIGN_IN_ONLY`                                           | `session.create.before`, `account.create.before` for operators                              | 403                |
| `TWO_FACTOR_REQUIRED`                                                   | `requireApiAuth` (428); `/two-factor/disable` for operators (403)                           | 428, 403           |
| `TRUST_DEVICE_DISABLED`                                                 | `hooks.before` on 2FA verify                                                                | 400                |
| `SESSION_LOOKUP_FAILED`                                                 | `requireApiAuth` / `requireApiSession` tri-state                                            | 503                |
| `RATE_LIMITED`                                                          | Edge and handler limiters                                                                   | 429                |
| `REQUEST_REJECTED`                                                      | Copy for a code-less 401/403 from `/api/auth/*` (origin or CSRF rejection)                  | 401, 403           |
| `SSO_PROVIDER_MISCONFIGURED`                                            | SSO provider routes when `oidcConfig` cannot be decrypted                                   | 200 body           |
| `SSO_PROVIDER_UNREACHABLE`                                              | `lib/sso/signin-with-toast.ts` when the IdP does not answer                                 | client             |
| `INVITATION_NOT_FOUND`, `_EXPIRED`, `_ALREADY_ACCEPTED`, `_NOT_FOR_YOU` | Copy keys the org invite page (`app/organizations/invite/[token]`) picks by response status | 404, 410, 409, 403 |

Two twoFactor codes are worth knowing: `INVALID_CODE` (wrong TOTP) and
`ACCOUNT_TEMPORARILY_LOCKED` (10 wrong codes, verification paused for 15
minutes). The second is the plugin's 2FA lockout, not a password lockout.

## 3. Resolution order

`humanizeAuthError(flow, error, options?)` in `lib/labels/auth-errors.ts` is
the only path from a failure to a sentence. `flow` is `signin`, `signup`,
`forgot`, `reset` or `verify`.

| #   | Step          | Decides                                                                                                                              |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | No error      | `GENERIC[flow]`                                                                                                                      |
| 1   | Code          | `normalizeAuthErrorCode` (trim, upper-case), then `AUTH_ERROR_COPY[code]`                                                            |
| 2   | Flow override | `AUTH_ERROR_COPY_BY_FLOW[flow][code]`, merged over the base entry                                                                    |
| 3   | Status        | 429 timed copy from `Retry-After`; 0 or 5xx `UNREACHABLE`; 401/403 `REQUEST_REJECTED`; 428, 410, 409 their own; else `GENERIC[flow]` |

Each entry carries `title`, `description`, optionally the `field` it belongs
under, `needsVerification`, and an `action` from a closed set
(`forgot-password`, `resend-verification`, `request-new-link`, `switch-to-sso`,
`sign-in`, `sign-up`, `retry`, `contact-support`, `enroll-2fa`).

Flow overrides exist for `reset` and `verify` because a reset link lasts 30
minutes and a verification link an hour. `forgot` has none on purpose: any
override there could vary on whether the address exists.

A 401 or 403 with no code from `/api/auth/*` means the request never reached a
handler (usually `trustedOrigins` on a deploy preview), so it is not reported as
a wrong password.

BetterAuth's 429 carries only `X-Retry-After`; `withRetryAfter` in
`lib/auth/rate-limit.ts` copies it to `Retry-After` so the copy can say how long
to wait.

## 4. Adding a code

1. Mint it in exactly one place, with `{ code, message }` on the `APIError` or
   JSON body.
2. Add it to `AppAuthErrorCode` and to the `AUTH_ERROR_CODES` const.
3. Add its copy to `AUTH_ERROR_COPY`. `tsc` fails until you do.
4. Ask the review question: does this sentence reveal anything about another
   person's account? If yes, collapse it into an existing generic code.

## 5. Deliberately absent

- No graded disclosure or account-state hints after failed attempts.
- No captcha codes; there is no captcha.
- No password lockout codes; brute force is a rate-limit concern
  ([rate-limiting-and-abuse.md](./rate-limiting-and-abuse.md)).
