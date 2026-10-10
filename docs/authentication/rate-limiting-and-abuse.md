# Rate limiting and abuse controls

| Field         | Value                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                          |
| Audience      | Engineers, on-call                                                                            |
| Last reviewed | 2026-10-09                                                                                    |
| Source        | `lib/auth/rate-limit.ts`, `lib/auth/password-policy.ts`, `lib/rate-limit.ts`, `middleware.ts` |

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
| `/sign-up/email`                       | 5 / hour      | Each call sends mail to an address the caller chose                 |
| `/request-password-reset`              | 3 / hour      | Mails anyone's inbox                                                |
| `/email-otp/send-verification-otp`     | 5 / hour      | Mails anyone's inbox                                                |
| `/reset-password`                      | 20 / hour     | Single-use token                                                    |
| `/reset-password/*`                    | 10 / hour     | Token in the path, so effectively per token                         |
| `/email-otp/verify-email`              | 10 / 15 min   | Code guessing; the code itself also locks after 5 wrong tries       |
| `/sign-in/social`, `/callback/*`       | 30 / 15 min   | IdP retries on flaky networks; a 429 reads as "Google is broken"    |
| `/sign-in/sso`                         | 20 / 15 min   | Same                                                                |
| `/sso/callback`, `/sso/callback/*`     | 30 / 15 min   | Same                                                                |
| `/get-session`, `/sign-out`            | unlimited     | Read on every page and focus; never strand a user signing out       |
| anything else                          | 100 / min     | Default                                                             |

Rules match in order and `*` matches one path segment, so specific patterns
come first. These `customRules` replace the emailOTP plugin's own default of 3
per minute on its paths.

**Verification codes.** A code is 6 digits, lives 10 minutes
(`VERIFICATION_CODE_TTL_SECONDS`) and is stored hashed. Five wrong tries kill it
whichever IP sent them (`allowedAttempts: 5`, answer `TOO_MANY_ATTEMPTS`), so
the per-IP budget bounds a distributed guesser to 5 guesses per code against
10^6 possibilities. Only `type: "email-verification"` can be requested over
HTTP (`lib/auth/core-policy.ts`); the plugin's sign-in, reset and email-change
paths are disabled.

## 3. Edge and handler limiters

| Scope                         | Route                                            | Budget                 | Where   |
| ----------------------------- | ------------------------------------------------ | ---------------------- | ------- |
| `enterprise.sso-domain-check` | `GET /api/auth/sso/domain-check`                 | 1000 / hour per IP     | Edge    |
| `enterprise.invite-accept`    | `POST /api/organizations/invitations/accept`     | 60 / hour per IP       | Edge    |
| session management            | `/api/user/sessions*` except `/current`          | 120 / 15 min per IP    | Edge    |
| session management, per user  | same                                             | 60 / 15 min per user   | Handler |
| `platform.staff-create`       | `POST /api/admin/team/members`, `.../setup-link` | 20 / hour per ADMIN    | Handler |
| re-authentication             | `POST /api/user/reauthenticate`                  | 5 / 15 min per user    | Handler |
| referral check                | `GET /api/referrals/code/check/[code]`           | 10 / min per IP        | Handler |
| existing-account notice       | sent from `onExistingUserSignUp`                 | 2 / hour per recipient | Handler |

The referral check keys on `getClientIp` (`x-nf-client-connection-ip`) and
answers only `valid` and the referrer's first name, so it cannot be used to
harvest full names.

These limiters are declared with `makeLimiter` in `lib/rate-limit.ts` (budget,
window, Redis prefix). Account keys there are
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
| Email verification before a credential session | `requireEmailVerification`; the 6-digit code is typed into the tab that chose the password              |
| Enumeration-safe sign-up                       | See below                                                                                               |
| Unverified-account purge                       | `purge-unverified-users` registry job, daily from GitHub Actions                                        |
| No auto-link on unverified email               | No `trustedProviders`                                                                                   |
| Generic sign-in errors                         | [errors.md](./errors.md)                                                                                |
| 2FA lockout                                    | twoFactor plugin: 10 consecutive wrong codes, 15-minute pause                                           |
| Hashed tokens at rest                          | Reset and verification identifiers stored as SHA-256                                                    |
| CSP                                            | Report-only to Sentry, see [security headers](../enterprise/20-iam-and-security/04-security-headers.md) |

### Enumeration safety

- **Sign-up answers one shape.** A new address, an existing one and a sign-up
  that loses the `User.email` unique race all return `{ token: null, user }`
  with the same keys (`canonicalSignUpUser` in `lib/auth/core-policy.ts`).
- **The existing owner is told, not the caller.** `onExistingUserSignUp` sends
  the "someone tried to sign up with your address" notice
  (`EXISTING_ACCOUNT_SIGN_UP`), throttled to 2 per hour per recipient by
  `existingAccountNoticeLimiter` keyed on `sha256(lower(email))`. The limiter
  fails open: a Redis error sends the notice.
- **Timing does not leak.** All auth mail runs in BetterAuth's
  `advanced.backgroundTasks`, whose handler is `scheduleAfter` (Netlify
  `waitUntil`), so the response returns before any mail is rendered or sent.
- **Codes go only to unverified accounts.** `sendVerificationCode`
  (`lib/auth/account-lifecycle.ts`) sends nothing for an unknown or already
  verified address, while the endpoint still answers `{ success: true }`.

### Residual risk: pre-registered address

An attacker can sign up with a victim's address and their own password. If the
victim later requests a code for that address and types it in, they verify the
attacker's account. Mitigations:

- The victim's sign-up attempt sends the existing-account notice, which steers
  them to password reset. A reset verifies the address, rotates the password,
  revokes every session and deletes outstanding tokens (`onPasswordChanged`).
- `purge-unverified-users` deletes never-verified, credential-only consumer
  accounts with nothing attached after 7 days, freeing the address.
- Turnstile on sign-up and per-account throttles are a later change.

## 6. Deliberately absent

| Not built           | Why                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Captcha             | Rate limits and HIBP cover the launch threat. Add it when bot traffic shows up, and test every gated flow end to end |
| Password lockout    | Lets anyone lock out any victim. Per-IP limits plus the 2FA lockout for operators instead                            |
| Email codes as 2FA  | Shares a channel with password reset, so it adds little as a second factor                                           |
| Break-glass account | A standing bypass is a standing target. Operator recovery is the ADMIN 2FA reset                                     |
| Account-state hints | Graded disclosure is an enumeration oracle                                                                           |

## 7. Adding a limit

- **A BetterAuth path:** add a rule to `AUTH_RATE_LIMIT_RULES`, more specific
  patterns first. Nothing else is needed.
- **Anything else:** `makeLimiter` in `lib/rate-limit.ts` plus an edge rule in
  `middleware.ts` (IP-keyed) or a handler call (account- or token-keyed; hash
  any address used in a key).

## Deprecated & Superseded Approaches

- **Link verification limits** (`/send-verification-email` 10/h, `/verify-email`
  30/h): the link endpoints are in `disabledPaths`; the 6-digit code paths
  replaced them because a link can be clicked by anyone who receives it.
- **Awaited auth mail:** sign-up and reset used to wait on Resend inline, which
  made response time an account-existence oracle. Mail now runs in
  `advanced.backgroundTasks`.
- **First-hop `x-forwarded-for` keys** on the referral check: client-controlled
  on Netlify, so the limit was bypassable. Use `getClientIp`.
