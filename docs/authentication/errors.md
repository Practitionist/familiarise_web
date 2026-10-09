# Auth errors: what a customer is told

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| Status        | Live                                                                     |
| Audience      | Engineers changing auth pages or minting auth refusals                   |
| Last reviewed | 2026-10-09                                                               |
| Source        | `lib/labels/auth-errors.ts`, `__tests__/auth/auth-error-catalog.test.ts` |

## 1. The rules

1. **Sign-in failures are generic.** A wrong email and a wrong password both
   answer `INVALID_EMAIL_OR_PASSWORD`. Forgot-password answers the same way
   for known and unknown addresses. No response, header or timing branch tells
   a caller whether an account exists.
2. **The server's message is never shown.** BetterAuth's messages are written
   for developers. `humanizeAuthError` maps a code or a status to our own copy
   and never echoes `error.message`.
3. **The set of codes is closed.** `AuthErrorCode` is `keyof typeof
AUTH_ERROR_COPY`, so a code has copy by construction, and anything outside
   the catalog normalises to `null` and falls back to status copy.

## 2. The catalog

`AUTH_ERROR_COPY` in `lib/labels/auth-errors.ts` holds the BetterAuth codes a
customer can reach through our UI (core, the admin plugin's `BANNED_USER`, the
twoFactor and passkey plugins) and the codes this codebase mints.
`__tests__/auth/auth-error-catalog.test.ts` checks that every code has
non-empty copy in every flow and that no server text leaks. Back-office
authorization codes (`YOU_ARE_NOT_ALLOWED_*`) and `OpsRefusal` codes from
`withOpsAction` routes are left out on purpose.

Codes this codebase mints:

| Code                                                                    | Minted by                                                                                                                                               | Status             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `PASSWORD_COMPROMISED`                                                  | `lib/auth/password-policy.ts` (HIBP)                                                                                                                    | 400                |
| `SSO_REQUIRED`                                                          | `session.create.before` SSO veto                                                                                                                        | 403                |
| `STAFF_PASSWORD_SIGN_IN_ONLY`                                           | `session.create.before`, `account.create.before` for operators                                                                                          | 403                |
| `TWO_FACTOR_REQUIRED`                                                   | `requireApiAuth` (428); `/two-factor/disable` for operators (403); `/change-password`, `/change-email`, `/update-user` for an unenrolled operator (403) | 428, 403           |
| `TWO_FACTOR_OPERATORS_ONLY`                                             | `hooks.before` on `/two-factor/enable` for anyone but an operator (`lib/auth/two-factor-policy.ts`)                                                     | 403                |
| `REAUTH_REQUIRED`                                                       | Step-up gate (`lib/auth/step-up.ts`): BetterAuth `hooks.before`, `requireFreshSession` in app routes, `withOpsAction({ stepUp: true })`                 | 403                |
| `PASSKEY_OPERATORS_ONLY`                                                | Passkey registration by anyone but an enrolled operator; passkey sign-in by a non-operator (`lib/auth/passkey-policy.ts`)                               | 403, 400           |
| `PASSKEY_USER_VERIFICATION_REQUIRED`                                    | A passkey ceremony without device PIN or biometrics (`lib/auth/passkey-policy.ts`)                                                                      | 400, 401           |
| `TRUST_DEVICE_DISABLED`                                                 | `hooks.before` on 2FA verify                                                                                                                            | 400                |
| `SESSION_LOOKUP_FAILED`                                                 | `requireApiAuth` / `requireApiSession` tri-state                                                                                                        | 503                |
| `RATE_LIMITED`                                                          | Edge and handler limiters                                                                                                                               | 429                |
| `REQUEST_REJECTED`                                                      | Copy for a code-less 401/403 from `/api/auth/*` (origin or CSRF rejection)                                                                              | 401, 403           |
| `SSO_PROVIDER_MISCONFIGURED`                                            | SSO provider routes when `oidcConfig` cannot be decrypted                                                                                               | 200 body           |
| `SSO_PROVIDER_UNREACHABLE`                                              | `lib/sso/signin-with-toast.ts` when the IdP does not answer                                                                                             | client             |
| `SSO_EMAIL_DOMAIN_MISMATCH`                                             | `user.create.before`, `account.create.before` on an SSO email outside the provider's domain                                                             | 302 to `?error=`   |
| `INVITATION_NOT_FOUND`, `_EXPIRED`, `_ALREADY_ACCEPTED`, `_NOT_FOR_YOU` | Copy keys the org invite page (`app/organizations/invite/[token]`) picks by response status                                                             | 404, 410, 409, 403 |

`REAUTH_REQUIRED` is rarely rendered as an error: `fetchWithReauth` /
`withReauth` (`lib/auth/reauth-client.ts`) catch it, open `<ReauthDialog>`, and
retry the original call once after `POST /api/user/reauthenticate` succeeds.
That route's own refusals (`INVALID_PASSWORD`, `INVALID_CODE`, `TOTP_REQUIRED`,
`NO_PASSWORD`) are shown inside the dialog.

twoFactor plugin codes on the challenge page (`/auth/two-factor`):

| Code                                  | When                                                                               | Next step                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| `INVALID_CODE`, `INVALID_BACKUP_CODE` | Wrong TOTP or backup code                                                          | Try again                                        |
| `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`  | 5 wrong codes on one challenge; the pending cookie is void                         | **Sign in again**                                |
| `INVALID_TWO_FACTOR_COOKIE`           | The 10-minute challenge expired, or another tab finished it                        | **Sign in again**, or go on if already signed in |
| `ACCOUNT_TEMPORARILY_LOCKED`          | 10 consecutive wrong codes; verification paused for 15 minutes, lockout email sent | Wait                                             |

`ACCOUNT_TEMPORARILY_LOCKED` is the plugin's 2FA lockout, not a password
lockout.

## 3. Resolution order

`humanizeAuthError(flow, error, options?)` in `lib/labels/auth-errors.ts` is
the only path from a failure to a sentence. `flow` is `signin`, `signup`,
`forgot`, `reset` or `verify`.

| #   | Step          | Decides                                                                                                       |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| 0   | No error      | `FLOW_FALLBACK_COPY[flow]`                                                                                    |
| 1   | Code          | `normalizeAuthErrorCode` (trim, upper-case), then `AUTH_ERROR_COPY[code]`                                     |
| 2   | Flow override | `AUTH_ERROR_COPY_BY_FLOW[flow][code]`, merged over the base entry                                             |
| 3   | Status        | 429 timed copy from `Retry-After`; 401/403 `REQUEST_REJECTED`; 0 or 5xx `UNREACHABLE`; else the flow fallback |

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
2. Add its copy to `AUTH_ERROR_COPY`. `AuthErrorCode` and `AUTH_ERROR_CODES`
   derive from it; a code without an entry renders as status copy.
3. Ask the review question: does this sentence reveal anything about another
   person's account? If yes, collapse it into an existing generic code.

## 5. Deliberately absent

- No graded disclosure or account-state hints after failed attempts.
- No captcha codes; there is no captcha.
- No password lockout codes; brute force is a rate-limit concern
  ([rate-limiting-and-abuse.md](./rate-limiting-and-abuse.md)).

## Deprecated & Superseded Approaches

- **Split code union.** `lib/labels/auth-error-codes.ts` (a
  `BetterAuthErrorCode | AppAuthErrorCode` union checked against
  `auth.$ERROR_CODES`) and `auth-errors.catalog.ts` were folded into
  `lib/labels/auth-errors.ts`. Do not recreate them.
- **Per-account sign-in lockout codes** were removed with the graded
  disclosure gate; only the twoFactor plugin's 2FA lockout remains.
