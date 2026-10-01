# Auth failure modes

| Field         | Value                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                         |
| Audience      | On-call, engineers                                                                           |
| Last reviewed | 2026-10-01                                                                                   |
| Runbooks      | [`docs/enterprise/50-operations/03-runbooks.md`](../enterprise/50-operations/03-runbooks.md) |

Two rules decide almost every row below:

1. **Fail open on availability.** A rate-limit store, the breached-password
   API or an email provider being down must not stop people signing in.
2. **Never turn "we don't know" into "signed out".** A failed session lookup
   is a 503 with `Retry-After`; only a confirmed 401 or 403 ends a session on
   the client.

## 1. Matrix

| #   | Failure                                               | What the user sees                                                       | What the code does                                                                                                                                                   | On-call action                                                                                                                  |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Upstash unreachable, slow (over 500 ms) or over quota | Nothing; limits are not enforced                                         | BetterAuth store and `applyRateLimit` both fail open, with throttled Sentry events (`auth:rate-limit-store`, `rate-limit:applyRateLimit`)                            | Restore Redis or raise the plan. Watch the daily command count ([Upstash pricing](../upstash/00-pricing-overview.md))           |
| 2   | Postgres blip or pool exhausted (`PG_POOL_MAX=1`)     | "We couldn't reach the sign-in service. Nothing was changed." (503)      | `lookupSession` returns `failed`; `requireApiAuth` answers 503 `SESSION_LOOKUP_FAILED` + `Retry-After: 2`; the focus probe treats 503 as unknown and never signs out | Check Supabase health and pooler limits                                                                                         |
| 3   | Resend down or misconfigured                          | Verification, reset or staff setup email does not arrive                 | `deliver()` dead-letters into `FailedEmail` and the retry worker replays it. Team page **Add staff** reports `setupLinkSent: false` instead of failing               | Fix Resend; then use **Resend setup link** for affected staff                                                                   |
| 4   | Have I Been Pwned unreachable or slow (over 2 s)      | Nothing; the password is accepted                                        | `breachedPasswordCheck` fails open and reports `auth:hibp` (throttled)                                                                                               | None unless it persists                                                                                                         |
| 5   | Netlify cold-instance stall (about 25 s)              | "We couldn't reach the sign-in service." (fetch status 0)                | Mapped to `UNREACHABLE`; `lib/auth/expected-auth-failures.ts` marks it expected so it does not page                                                                  | None; platform-side                                                                                                             |
| 6   | Google or GitHub outage                               | Social sign-in fails                                                     | Nothing special. Users with a password can still use it; others can use **Forgot password** to add one                                                               | Wait for the provider                                                                                                           |
| 7   | Customer IdP unreachable                              | "We couldn't reach your identity provider." (`SSO_PROVIDER_UNREACHABLE`) | No fallback under `enforceSSO`, by design                                                                                                                            | Tell the customer; it is their IdP                                                                                              |
| 8   | `AUTH_CONFIG_ENCRYPTION_KEY` missing or wrong         | SSO users cannot sign in; OWNER sees `SSO_PROVIDER_MISCONFIGURED`        | Decryption fails with `key_unavailable` (or `auth_failed`); creating a provider is refused                                                                           | Restore the key. If rotating, see [SSO secret key rotation](../enterprise/50-operations/03-runbooks.md#sso-secret-key-rotation) |
| 9   | `BETTER_AUTH_SECRET` changed or missing               | Everyone signed out; operators' authenticator codes stop working         | Session cookies are signed, and TOTP secrets, backup codes and OAuth tokens are encrypted, with this secret                                                          | Never change it in place. Rotate with versioned `BETTER_AUTH_SECRETS` (new first, old kept) so encrypted data still decrypts    |
| 10  | `trustedOrigins` wrong on a deploy preview            | "This sign-in request was blocked."                                      | Code-less 401/403 from `/api/auth/*` maps to `REQUEST_REJECTED`                                                                                                      | Use the main site, or add the preview origin to `BETTER_AUTH_TRUSTED_ORIGINS`                                                   |
| 11  | Prisma schema missing a column BetterAuth writes      | Every `/api/auth/*` call fails at runtime                                | CI's "Auth schema guard" (`scripts/ci/check-auth-schema.ts`) fails the build first                                                                                   | Add the column additively ([ADR 36](../enterprise/70-design-decisions/36-auth-schema-freeze.md))                                |
| 12  | BetterAuth endpoint throws                            | A 500 on an auth page                                                    | BetterAuth swallows the exception; `reportAuthLogToSentry` forwards error-level logs to Sentry                                                                       | Read the Sentry event (`subsystem: auth`)                                                                                       |
| 13  | Operator without 2FA calls an API                     | 428 `TWO_FACTOR_REQUIRED`, pages redirect to `/auth/two-factor/setup`    | Working as designed                                                                                                                                                  | None                                                                                                                            |
| 14  | Operator lost their authenticator                     | Cannot finish sign-in                                                    | Backup codes; otherwise an ADMIN reset                                                                                                                               | [Lost authenticator](../enterprise/50-operations/03-runbooks.md#lost-authenticator-admin-2fa-reset)                             |
| 15  | Operator account compromised or person leaving        | n/a                                                                      | Suspend bans the account and deletes every session at once                                                                                                           | [Staff off-boarding](../enterprise/50-operations/03-runbooks.md#staff-off-boarding)                                             |
| 16  | A page breaks a CSP directive                         | Nothing while report-only                                                | Browser sends a report to Sentry's security endpoint                                                                                                                 | [CSP runbook](../enterprise/50-operations/03-runbooks.md#content-security-policy-csp)                                           |
| 17  | Sentry unreachable or over quota                      | Nothing, which is the problem                                            | `captureThrottled` caps repeated events per window                                                                                                                   | Treat as loss of diagnosability, not of auth                                                                                    |

## 2. Environment variables

| Variable                                                     | Needed for                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` (or `BETTER_AUTH_SECRETS`)              | Cookie signing; encryption of TOTP secrets, backup codes, OAuth tokens                             |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`                     | Base URL, redirects, SSO callback URLs                                                             |
| `BETTER_AUTH_TRUSTED_ORIGINS`                                | Extra origins (comma-separated), e.g. previews                                                     |
| `GOOGLE_CLIENT_ID`/`_SECRET`, `GITHUB_CLIENT_ID`/`_SECRET`   | Social sign-in                                                                                     |
| `AUTH_CONFIG_ENCRYPTION_KEY` (+ `_PREVIOUS` during rotation) | SSO provider config encryption, 64 hex characters                                                  |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN`                            | Both rate limiters (fail open without them)                                                        |
| `RESEND_API_KEY`                                             | Verification, reset and staff setup email                                                          |
| `NEXT_PUBLIC_SENTRY_DSN`                                     | Error reporting and the CSP report endpoint (read at build time)                                   |
| `ENABLE_CSP_ENFORCE`                                         | `true` at build time switches CSP from report-only to enforced                                     |
| `STRICT_BUILD`                                               | Strict by default. `false` skips type-check and lint inside `next build` on Netlify (stopgap only) |

## 3. Related

- [rate-limiting-and-abuse.md](./rate-limiting-and-abuse.md)
- [errors.md](./errors.md)
- [Required secrets](../enterprise/50-operations/07-required-secrets.md)
- [Monitoring](../enterprise/50-operations/04-monitoring.md)
