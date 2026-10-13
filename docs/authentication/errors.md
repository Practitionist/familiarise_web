# Auth errors: what a customer is told

| Field         | Value                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                                                                  |
| Audience      | Engineers changing auth pages or minting auth refusals                                                                                |
| Last reviewed | 2026-10-10                                                                                                                            |
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
| `isPasskeyCancellation`                                                  | True for a dismissed or timed-out WebAuthn prompt, which shows nothing.                         |
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

| Family                   | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Credentials              | `INVALID_EMAIL_OR_PASSWORD`, `INVALID_PASSWORD`, `CREDENTIAL_ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `PASSWORD_COMPROMISED`, `PASSWORD_ALREADY_SET`, `FAILED_TO_UNLINK_LAST_ACCOUNT`                                                                                                                                                                                                                                                                                                                           | `PASSWORD_TOO_LONG` is the 72-byte bcrypt limit (`lib/auth/password-rules.ts`), minted by `lib/auth/password-policy.ts`           |
| Sign-up input            | `NAME_INVALID`, `INVALID_EMAIL`, `FAILED_TO_CREATE_USER`, `FAILED_TO_UPDATE_USER`, `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, `VALIDATION_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                             | `NAME_INVALID` comes from `parseDisplayName` in `lib/auth/core-policy.ts` (`DisplayNameSchema`)                                   |
| Email verification (OTP) | `EMAIL_NOT_VERIFIED`, `INVALID_OTP`, `OTP_EXPIRED`, `TOO_MANY_ATTEMPTS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `EMAIL_NOT_VERIFIED` sets `needsVerification`; the sign-in page then opens the code page                                          |
| Reset links              | `INVALID_TOKEN`, `TOKEN_EXPIRED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `reset` overrides name the 30-minute window                                                                                       |
| Session                  | `SESSION_EXPIRED`, `SESSION_NOT_FRESH`, `SESSION_LOOKUP_FAILED`, `REAUTH_REQUIRED`, `IDENTITY_CHANGED`, `USER_NOT_FOUND`, `BANNED_USER`                                                                                                                                                                                                                                                                                                                                                                                                                    | `SESSION_LOOKUP_FAILED` is `UNREACHABLE`                                                                                          |
| OAuth/SSO callback       | `ACCOUNT_NOT_LINKED`, `UNABLE_TO_LINK_ACCOUNT`, `ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER`, `ACCOUNT_OWNERSHIP_CONFLICT`, `EMAIL_DOES_NOT_MATCH`, `EMAIL_NOT_FOUND`, `ACCESS_DENIED`, `STATE_MISMATCH`, `STATE_NOT_FOUND`, `INVALID_STATE`, `PLEASE_RESTART_THE_PROCESS`, `INVALID_CALLBACK_REQUEST`, `NO_CODE`, `UNABLE_TO_GET_USER_INFO`, `OAUTH_PROVIDER_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `ISSUER_MISMATCH`, `INVALID_PROVIDER`, `TOKEN_NOT_VERIFIED`, `UNABLE_TO_CREATE_USER`, `UNABLE_TO_CREATE_SESSION`, `SIGNUP_DISABLED`, `INTERNAL_SERVER_ERROR` | `ACCOUNT_NOT_LINKED` (social sign-in onto an unverified credential account) answers `forgot-password`: a reset proves the address |
| SSO                      | `SSO_REQUIRED`, `SSO_PROVIDER_MISCONFIGURED`, `SSO_EMAIL_DOMAIN_MISMATCH`, `SSO_NOT_PROVEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `SSO_NOT_PROVEN`: enforcement needs one successful owner SSO sign-in first                                                        |
| Two-factor               | `TWO_FACTOR_REQUIRED`, `TWO_FACTOR_OPERATORS_ONLY`, `STAFF_PASSWORD_SIGN_IN_ONLY`, `TRUST_DEVICE_DISABLED`, `INVALID_CODE`, `INVALID_BACKUP_CODE`, `INVALID_TWO_FACTOR_COOKIE`, `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`, `ACCOUNT_TEMPORARILY_LOCKED`, `TOTP_ALREADY_ENABLED`, `TOTP_NOT_ENABLED`, `SELF_RESET_FORBIDDEN`                                                                                                                                                                                                                                     | `ACCOUNT_TEMPORARILY_LOCKED` is the plugin's 2FA lockout, not a password lockout                                                  |
| Passkeys                 | `PASSKEY_OPERATORS_ONLY`, `PASSKEY_USER_VERIFICATION_REQUIRED`, `PASSKEY_NOT_FOUND`, `ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED`                                                                                                                                                                                                                                                                                                                                                                                                                           | A dismissed browser prompt is `isPasskeyCancellation` and shows nothing                                                           |
| Transport and limits     | `RATE_LIMITED`, `REQUEST_REJECTED`, `INVALID_ORIGIN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                   |
| Onboarding and invites   | `ALREADY_ONBOARDED`, `INVITATION_NOT_FOUND`, `_EXPIRED`, `_ALREADY_ACCEPTED`, `_NOT_FOR_YOU`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Invitation keys are picked by the invite page from the response status                                                            |

`auth-error-callback-codes.test.ts` pins every lowercase code BetterAuth's
OAuth and SSO callbacks redirect with, and every code the other auth routes
mint, to its own entry rather than the flow fallback.

### Codes this codebase mints

| Code                                        | Minted by                                                                                                                                               | Status    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `PASSWORD_COMPROMISED`, `PASSWORD_TOO_LONG` | `lib/auth/password-policy.ts` (HIBP, 72-byte cap)                                                                                                       | 400       |
| `NAME_INVALID`                              | `lib/auth/core-policy.ts`                                                                                                                               | 400       |
| `EMAIL_NOT_VERIFIED`                        | BetterAuth on an unverified credential sign-in; `user.create.before` on an unverified social email                                                      | 403       |
| `SSO_REQUIRED`                              | `session.create.before` SSO veto (`lib/sso/enforce-session.ts`)                                                                                         | 403       |
| `SSO_EMAIL_DOMAIN_MISMATCH`                 | `user.create.before`, `account.create.before` on an SSO email outside the provider's domains (`lib/sso/account-domain.ts`)                              | `?error=` |
| `SSO_NOT_PROVEN`                            | Enforce-on before an org OWNER has signed in through the provider                                                                                       | 409       |
| `SSO_PROVIDER_MISCONFIGURED`                | SSO provider routes when `oidcConfig` cannot be decrypted                                                                                               | 200 body  |
| `STAFF_PASSWORD_SIGN_IN_ONLY`               | `session.create.before`, `account.create.before` for operators                                                                                          | 403       |
| `TWO_FACTOR_REQUIRED`                       | `requireApiAuth` (428); `/two-factor/disable` for operators (403); `/change-password`, `/change-email`, `/update-user` for an unenrolled operator (403) | 428, 403  |
| `TWO_FACTOR_OPERATORS_ONLY`                 | `/two-factor/enable` for anyone but an operator (`lib/auth/two-factor-policy.ts`)                                                                       | 403       |
| `TRUST_DEVICE_DISABLED`                     | `hooks.before` on 2FA verify                                                                                                                            | 400       |
| `PASSKEY_OPERATORS_ONLY`                    | Passkey registration by anyone but an enrolled operator, or with `createSession`; passkey sign-in by a non-operator (`lib/auth/passkey-policy.ts`)      | 403, 400  |
| `PASSKEY_USER_VERIFICATION_REQUIRED`        | A passkey ceremony without device PIN or biometrics                                                                                                     | 400, 401  |
| `REAUTH_REQUIRED`                           | Step-up (`lib/auth/step-up.ts`): BetterAuth `hooks.before`, `requireFreshSession`, `withOpsAction({ stepUp: true })`                                    | 403       |
| `IDENTITY_CHANGED`                          | `requireApiAuth({ expectUser: true })`, `requireOrgAccess`, `withOpsAction` on an `X-Expected-User` mismatch                                            | 409       |
| `SESSION_LOOKUP_FAILED`                     | `SessionLookupFailedError`: guards, `apiError`, `/api/auth/get-session`                                                                                 | 503       |
| `SELF_RESET_FORBIDDEN`                      | Admin 2FA reset on the caller's own account                                                                                                             | 403       |
| `RATE_LIMITED`                              | Edge and handler limiters                                                                                                                               | 429       |
| `REQUEST_REJECTED`                          | Copy for a code-less 401/403 from `/api/auth/*` (origin or CSRF rejection)                                                                              | 401, 403  |

`REAUTH_REQUIRED` and `IDENTITY_CHANGED` are rarely rendered as errors:
`fetchWithReauth` / `withReauth` (`lib/auth/reauth-client.ts`) open
`<ReauthDialog>` and retry once after `POST /api/user/reauthenticate`
succeeds, and `fetchWithIdentity` reloads the tab on 409. The re-auth route's
own refusals (`INVALID_PASSWORD`, `INVALID_CODE`, `TOTP_REQUIRED`,
`NO_PASSWORD`, `SESSION_EXPIRED`) carry our own sentence in `error`, which the
dialog shows. The challenge page's codes and next steps are in
[architecture.md §5.3](./architecture.md#53-staff-sign-in-password-plus-totp-or-a-passkey).

The SSO claim-check refusals (`SSO_ID_TOKEN_MISSING`, `SSO_EMAIL_NOT_VERIFIED`,
`SSO_HOSTED_DOMAIN_MISMATCH`) and `SSO_ACCOUNT_ALREADY_LINKED` have no catalog
entry yet; see [sso.md §6](./sso.md#6-failure-answers) for what each means.

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
  and the deleted SSO sign-in toast wrapper; references to them are stale.
- **Per-account sign-in lockout codes**, removed with the graded disclosure
  gate; only the twoFactor plugin's 2FA lockout remains.
