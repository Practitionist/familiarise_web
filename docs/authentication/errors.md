# Auth errors: what a customer is told

| Field         | Value                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                                                                  |
| Audience      | Engineers changing auth pages or minting auth refusals                                                                                |
| Last reviewed | 2026-10-09                                                                                                                            |
| Source        | `lib/labels/auth-errors.ts`                                                                                                           |
| Tests         | `__tests__/auth/auth-error-catalog.test.ts`, `__tests__/auth/auth-errors.test.ts`, `__tests__/auth/auth-error-callback-codes.test.ts` |

## 1. The rules

1. **Sign-in failures are generic.** A wrong email and a wrong password both
   answer `INVALID_EMAIL_OR_PASSWORD`. Forgot-password and sign-up answer the
   same way for known and unknown addresses. No response, header or timing
   branch tells a caller whether an account exists
   ([rate-limiting-and-abuse.md](./rate-limiting-and-abuse.md)).
2. **The server's message is never shown.** BetterAuth's messages are written
   for developers. `humanizeAuthError` maps a code or a status to our own copy
   and never echoes `error.message` (it reads the message only to pick a field
   out of a `VALIDATION_ERROR`).
3. **One file owns every sentence.** `lib/labels/auth-errors.ts` is the whole
   catalog: types, entries, flow overrides and the humanizer. There is no
   separate codes file and no generated union.

## 2. The catalog

| Export                                                                   | Role                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `entry(title, description, fieldOrAction?, action?, needsVerification?)` | Builds one `AuthErrorCopy`. The third argument is a field if it names one, otherwise an action. |
| `AUTH_ERROR_COPY`                                                        | `as const satisfies Record<string, AuthErrorCopy>`; its keys are `AuthErrorCode`.               |
| `AUTH_ERROR_COPY_BY_FLOW`                                                | Partial per-flow overrides merged over the base entry (only `reset` has entries today).         |
| `normalizeAuthErrorCode`                                                 | Trims and upper-cases a raw code; returns it only if it is a catalog key.                       |
| `humanizeAuthError(flow, error, options?)`                               | The only path from a failure to a sentence.                                                     |
| `UNREACHABLE`                                                            | Copy for "the request never reached the service" (thrown fetch, status 0, 5xx).                 |
| `formatRetryAfter`                                                       | Renders a `Retry-After` wait ("2 minutes").                                                     |

Each `AuthErrorCopy` carries `title`, `description`, optionally the `field` it
renders under (`name`, `email`, `password`, `newPassword`, `referral`, `code`),
`needsVerification`, and an `action` from a closed set (`forgot-password`,
`resend-verification`, `request-new-link`, `switch-to-sso`, `sign-in`,
`sign-up`, `retry`, `contact-support`, `enroll-2fa`). A page maps the actions it
can service to a link or callback and renders them with
`components/auth/AuthErrorAffordance.tsx`; `retry` never renders a button.

## 3. Resolution order

`flow` is `signin`, `signup`, `forgot`, `reset` or `verify`.

| #   | Step          | Decides                                                                                                            |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Code          | `normalizeAuthErrorCode`, then `AUTH_ERROR_COPY[code]`; `VALIDATION_ERROR` first tries the field parser            |
| 2   | Flow override | `AUTH_ERROR_COPY_BY_FLOW[flow][code]`, merged over the base entry                                                  |
| 3   | Wait          | `RATE_LIMITED` or status 429 swaps in the timed description from `Retry-After`                                     |
| 4   | Status        | Unknown or absent code: 429 timed copy; 401/403 `REQUEST_REJECTED`; 0 or 5xx `UNREACHABLE`; else the flow fallback |

OAuth and SSO callbacks redirect to the page's `errorCallbackURL` with a
lowercase `?error=` code (`account_not_linked`, `state_mismatch`). Step 1
upper-cases it, so the catalog key is the upper-case form. The sign-in and
sign-up pages pass any `?error=` value straight to `humanizeAuthError`; an
unknown code gets the flow fallback, never the raw string.

A 401 or 403 with no code from `/api/auth/*` means the request never reached a
handler (usually `trustedOrigins` on a deploy preview), so it is not reported as
a wrong password. BetterAuth's 429 carries only `X-Retry-After`;
`withRetryAfter` in `lib/auth/rate-limit.ts` copies it to `Retry-After`, and the
pages read it with `components/auth/useRetryAfterCapture.ts`.

## 4. Code families

| Family                   | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Notes                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Credentials              | `INVALID_EMAIL_OR_PASSWORD`, `INVALID_PASSWORD`, `CREDENTIAL_ACCOUNT_NOT_FOUND`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `PASSWORD_COMPROMISED`, `PASSWORD_ALREADY_SET`                                                                                                                                                                                                                                                                                                                                                           | `PASSWORD_TOO_LONG` is the 72-byte bcrypt limit (`lib/auth/password-rules.ts`), minted by `lib/auth/password-policy.ts`           |
| Sign-up input            | `NAME_INVALID`, `INVALID_EMAIL`, `FAILED_TO_CREATE_USER`, `VALIDATION_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `NAME_INVALID` comes from `parseDisplayName` in `lib/auth/core-policy.ts` (`DisplayNameSchema`)                                   |
| Email verification (OTP) | `EMAIL_NOT_VERIFIED`, `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `EMAIL_NOT_VERIFIED` sets `needsVerification`; the sign-in page then opens the code page                                          |
| Reset links              | `INVALID_TOKEN`, `TOKEN_EXPIRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `reset` overrides name the 30-minute window                                                                                       |
| Session                  | `SESSION_EXPIRED`, `SESSION_NOT_FRESH`, `SESSION_LOOKUP_FAILED`, `USER_NOT_FOUND`, `BANNED_USER`                                                                                                                                                                                                                                                                                                                                                                                                                                     | `SESSION_LOOKUP_FAILED` is `UNREACHABLE`                                                                                          |
| OAuth/SSO callback       | `ACCOUNT_NOT_LINKED`, `UNABLE_TO_LINK_ACCOUNT`, `ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER`, `ACCOUNT_OWNERSHIP_CONFLICT`, `EMAIL_DOES_NOT_MATCH`, `EMAIL_NOT_FOUND`, `ACCESS_DENIED`, `STATE_MISMATCH`, `STATE_NOT_FOUND`, `INVALID_STATE`, `PLEASE_RESTART_THE_PROCESS`, `INVALID_CALLBACK_REQUEST`, `NO_CODE`, `UNABLE_TO_GET_USER_INFO`, `OAUTH_PROVIDER_NOT_FOUND`, `ISSUER_MISMATCH`, `INVALID_PROVIDER`, `TOKEN_NOT_VERIFIED`, `UNABLE_TO_CREATE_USER`, `UNABLE_TO_CREATE_SESSION`, `SIGNUP_DISABLED`, `INTERNAL_SERVER_ERROR` | `ACCOUNT_NOT_LINKED` (social sign-in onto an unverified credential account) answers `forgot-password`: a reset proves the address |
| SSO                      | `SSO_REQUIRED`, `SSO_PROVIDER_MISCONFIGURED`, `SSO_EMAIL_DOMAIN_MISMATCH`, `SSO_NOT_PROVEN`                                                                                                                                                                                                                                                                                                                                                                                                                                          | `SSO_NOT_PROVEN`: enforcement needs one successful owner SSO sign-in first                                                        |
| Minted by other routes   | `IDENTITY_CHANGED`, `REAUTH_REQUIRED`, `TWO_FACTOR_OPERATORS_ONLY`, `SELF_RESET_FORBIDDEN`, `ALREADY_ONBOARDED`                                                                                                                                                                                                                                                                                                                                                                                                                      | Cross-tab account switch, step-up re-auth, 2FA scope rules, onboarding replay                                                     |
| Two-factor               | `TWO_FACTOR_REQUIRED`, `STAFF_PASSWORD_SIGN_IN_ONLY`, `TRUST_DEVICE_DISABLED`, `INVALID_CODE`, `INVALID_BACKUP_CODE`, `INVALID_TWO_FACTOR_COOKIE`, `ACCOUNT_TEMPORARILY_LOCKED`                                                                                                                                                                                                                                                                                                                                                      | `ACCOUNT_TEMPORARILY_LOCKED` is the plugin's 2FA lockout, not a password lockout                                                  |
| Transport and limits     | `RATE_LIMITED`, `REQUEST_REJECTED`, `INVALID_ORIGIN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |                                                                                                                                   |
| Org invitations          | `INVITATION_NOT_FOUND`, `_EXPIRED`, `_ALREADY_ACCEPTED`, `_NOT_FOR_YOU`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Copy keys the invite page picks by response status                                                                                |

`auth-error-callback-codes.test.ts` pins every lowercase code BetterAuth's
OAuth and SSO callbacks redirect with, and every code the other auth routes
mint, to its own entry rather than the flow fallback.

## 5. Adding a code

1. Mint it in exactly one place, with `{ code, message }` on the `APIError` or
   JSON body.
2. Add its `entry()` to `AUTH_ERROR_COPY`. A page that renders an unknown code
   gets the flow fallback, so a missing entry degrades rather than breaks; the
   catalog tests are what catch it.
3. Ask the review question: does this sentence reveal anything about another
   person's account? If yes, collapse it into an existing generic code.

## 6. Deliberately absent

- No graded disclosure or account-state hints after failed attempts.
- No captcha codes; there is no captcha.
- No password lockout codes; brute force is a rate-limit concern.
- No `forgot` overrides: any override there could vary on whether the address
  exists.

## Deprecated & Superseded Approaches

- **Link-verification copy.** The `verify` flow overrides for `INVALID_TOKEN` /
  `TOKEN_EXPIRED` ("verification links last 1 hour") and `EMAIL_ALREADY_VERIFIED`
  were removed with the verification link; verification is a 6-digit code and
  its failures are the OTP family. Delete any page branch that still reads them.
- **`USER_ALREADY_EXISTS`.** Unreachable under `requireEmailVerification`:
  sign-up answers a duplicate address exactly like a new one.
- **Split catalog files.** `auth-error-codes.ts`, `auth-errors.catalog.ts`, the
  `BetterAuthErrorCode` / `AppAuthErrorCode` unions, `SSO_PROVIDER_UNREACHABLE`
  and `lib/sso/signin-with-toast.ts` do not exist; references to them are stale.
