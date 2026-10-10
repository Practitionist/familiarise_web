# Rate limiting and abuse controls

| Field         | Value                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Status        | Live                                                                                                   |
| Audience      | Engineers, on-call                                                                                     |
| Last reviewed | 2026-10-01                                                                                             |
| Source        | `lib/auth/rate-limit.ts`, `lib/auth/password-policy.ts`, `lib/rate-limit/policies.ts`, `middleware.ts` |

## 1. Two limiters, no overlap

| Layer                     | Covers                                                 | Store                          | Key                              |
| ------------------------- | ------------------------------------------------------ | ------------------------------ | -------------------------------- |
| BetterAuth `rateLimit`    | Every `/api/auth/*` endpoint, plugin paths included    | Upstash (`customStorage`)      | `sha256(clientIp + "\|" + path)` |
| Edge and handler limiters | App routes on the auth path that BetterAuth never sees | Upstash (`@upstash/ratelimit`) | IP, account digest or token      |

`middleware.ts` does **not** limit BetterAuth paths, so nothing is counted
twice. Running the auth limiter inside BetterAuth covers `/two-factor/*` and
any future plugin endpoint automatically, and matches the router's own path
normalisation.

## 2. BetterAuth limiter (`lib/auth/rate-limit.ts`)

- **Always on**, including previews (`enabled: true`; BetterAuth's default is
  production only).
- **Upstash store.** A Lua script runs `INCR` and the first-hit `PEXPIRE`
  atomically, so a counter can never be left without a TTL. The key is hashed
  because a path can carry a secret (`/reset-password/:token`).
- **Fails open.** A Redis error or a reply slower than 500 ms lets the request
  through and sends a throttled Sentry event (`auth:rate-limit-store`). A Redis
  outage must not lock everyone out of signing in.
- **Client IP** comes from `x-nf-client-connection-ip`, which Netlify sets and
  clients cannot forge. IPv6 is keyed on the /64.
- **Loopback** (`127.0.0.1`, `::1`) is skipped outside production so local and
  e2e runs are not throttled.
- **`Retry-After`.** BetterAuth sends only `X-Retry-After`; `withRetryAfter`
  copies it into `Retry-After` on the auth route.

| Path                                   | Budget per IP | Why                                                                 |
| -------------------------------------- | ------------- | ------------------------------------------------------------------- |
| `/sign-in/email`                       | 30 / 15 min   | Room for typos, far below a scripted sweep                          |
| `/change-password`, `/verify-password` | 5 / 15 min    | Signed-in guessing surface                                          |
| `/two-factor/verify-*`                 | 5 / min       | TOTP guessing; the plugin also locks 2FA after 10 straight failures |
| `/two-factor/*`                        | 10 / min      | Enrolment and backup-code management                                |
| `/sign-up/email`                       | 10 / hour     | Each call sends mail                                                |
| `/request-password-reset`              | 5 / hour      | Mails anyone's inbox                                                |
| `/send-verification-email`             | 10 / hour     | Mails anyone's inbox                                                |
| `/reset-password`                      | 20 / hour     | Single-use token                                                    |
| `/reset-password/*`                    | 10 / hour     | Token in the path, so effectively per token                         |
| `/verify-email`                        | 30 / hour     | Single-use token                                                    |
| `/sign-in/social`, `/callback/*`       | 30 / 15 min   | IdP retries on flaky networks; a 429 reads as "Google is broken"    |
| `/sign-in/sso`                         | 300 / 15 min  | Enforce-on signs out a whole office behind one NAT address          |
| `/sso/callback/*`                      | 1000 / 15 min | State and PKCE are single-use; only a flood ceiling                 |
| `/get-session`, `/sign-out`            | unlimited     | Read on every page and focus; never strand a user signing out       |
| anything else                          | 100 / min     | Default                                                             |

Rules match in order and `*` matches one path segment, so specific patterns
come first.

## 3. Edge and handler limiters

| Scope                         | Route                                            | Budget               | Where   |
| ----------------------------- | ------------------------------------------------ | -------------------- | ------- |
| `enterprise.sso-domain-check` | `GET /api/auth/sso/domain-check`                 | 1000 / hour per IP   | Edge    |
| `enterprise.invite-accept`    | `POST /api/organizations/invitations/accept`     | 60 / hour per IP     | Edge    |
| session management            | `/api/user/sessions*` except `/current`          | 120 / 15 min per IP  | Edge    |
| session management, per user  | same                                             | 60 / 15 min per user | Handler |
| `platform.staff-create`       | `POST /api/admin/team/members`, `.../setup-link` | 20 / hour per ADMIN  | Handler |

The `enterprise.*` and `platform.*` scopes are declared once in
`lib/rate-limit/policies.ts` (scope, window, budgets, rationale) and reported
verbatim in the 429 body as `scope`. Account keys there are
`sha256(lower(trim(email)))`, never addresses, because Redis keys are plaintext
at rest. These limiters also fail open.

`/api/user/sessions/current` is exempt: every open tab calls it on focus.

The invite-accept policy also declares a 20 / hour per-invitation budget, but
no handler spends it yet (open item).

## 4. Breached passwords (`lib/auth/password-policy.ts`)

Our own BetterAuth plugin, `breachedPasswordCheck`, wraps password hashing on
`/sign-up/email`, `/change-password` and `/reset-password`:

- Sends only the first 5 hex characters of the SHA-1 to the Have I Been Pwned
  range API, with `Add-Padding: true`.
- Any match is refused with `PASSWORD_COMPROMISED`.
- 2-second timeout. On a timeout or error it **fails open** and sends a
  throttled Sentry event (`auth:hibp`). BetterAuth's own `haveIBeenPwned` plugin
  fails closed, which would turn an HIBP outage into a sign-up outage.
- Admin-created operator accounts are not checked: their random password is
  never used.

## 5. Other abuse controls

| Control                                        | Where                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Email verification before a credential session | `requireEmailVerification`; stops pre-registering a victim's address                                    |
| No auto-link on unverified email               | No `trustedProviders`                                                                                   |
| Generic sign-in errors                         | [errors.md](./errors.md)                                                                                |
| 2FA lockout                                    | twoFactor plugin: 10 consecutive wrong codes, 15-minute pause                                           |
| Hashed tokens at rest                          | Reset and verification identifiers stored as SHA-256                                                    |
| CSP                                            | Report-only to Sentry, see [security headers](../enterprise/20-iam-and-security/04-security-headers.md) |

## 6. Deliberately absent

| Not built            | Why                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Captcha              | Rate limits and HIBP cover the launch threat. Add it when bot traffic shows up, and test every gated flow end to end |
| Password lockout     | Lets anyone lock out any victim. Per-IP limits plus the 2FA lockout for operators instead                            |
| Email one-time codes | Shares a channel with password reset, so it adds little as a second factor                                           |
| Break-glass account  | A standing bypass is a standing target. Operator recovery is the ADMIN 2FA reset                                     |
| Account-state hints  | Graded disclosure is an enumeration oracle                                                                           |

## 7. Adding a limit

- **A BetterAuth path:** add a rule to `AUTH_RATE_LIMIT_RULES`, more specific
  patterns first. Nothing else is needed.
- **An app route on the auth path:** declare a policy in
  `lib/rate-limit/policies.ts` and either add an edge rule in `middleware.ts`
  that names it (IP-keyed) or call `applyRateLimit(limiterFor(scope, dim), key)`
  in the handler (account- or token-keyed).
- **Anything else:** `makeLimiter` in `lib/rate-limit.ts` plus an edge rule or
  a handler call.
