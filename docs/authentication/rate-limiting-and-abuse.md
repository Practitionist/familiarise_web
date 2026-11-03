# Rate limiting and abuse controls

| Field         | Value                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| Status        | Live                                                                                          |
| Audience      | Engineers, on-call                                                                            |
| Last reviewed | 2026-10-26                                                                                    |
| Source        | `lib/auth/rate-limit.ts`, `lib/auth/password-policy.ts`, `lib/rate-limit.ts`, `middleware.ts` |
| Also          | `lib/auth/captcha.ts`, `lib/auth/account-throttle.ts`, `lib/email/recipient-cap.ts`           |

## 1. Two limiters, no overlap

| Layer                     | Covers                                                 | Store                          | Key                              |
| ------------------------- | ------------------------------------------------------ | ------------------------------ | -------------------------------- |
| BetterAuth `rateLimit`    | Every `/api/auth/*` endpoint, plugin paths included    | Upstash (`customStorage`)      | `sha256(clientIp + "\|" + path)` |
| Edge and handler limiters | App routes on the auth path that BetterAuth never sees | Upstash (`@upstash/ratelimit`) | IP, account digest or token      |

`middleware.ts` does **not** limit BetterAuth paths, so nothing is counted
twice. Three controls are keyed on something other than the IP, so a proxy
pool gets no fresh budget from them: Turnstile on the mail-sending endpoints,
the per-account sign-in throttle and the per-recipient mail cap (§5). Running the auth limiter inside BetterAuth covers `/two-factor/*` and
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
- **Client IP** comes from `x-familiarise-client-ip`, which edge middleware
  overwrites on every request with the address it resolved, so clients cannot
  forge it. IPv6 is keyed on the /64.
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
| `/sign-in/sso`                         | 300 / 15 min  | Enforce-on signs a whole office out at once behind one NAT address  |
| `/sso/callback/*`                      | 1000 / 15 min | Same; state and PKCE are single-use, so this only stops floods      |
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

| Scope                         | Route                                            | Budget               | Where   |
| ----------------------------- | ------------------------------------------------ | -------------------- | ------- |
| `enterprise.sso-domain-check` | `GET /api/auth/sso/domain-check`                 | 1000 / hour per IP   | Edge    |
| `enterprise.invite-accept`    | `POST /api/organizations/invitations/accept`     | 60 / hour per IP     | Edge    |
| session management            | `/api/user/sessions*` except `/current`          | 120 / 15 min per IP  | Edge    |
| session management, per user  | same                                             | 60 / 15 min per user | Handler |
| `platform.staff-create`       | `POST /api/admin/team/members`, `.../setup-link` | 20 / hour per ADMIN  | Handler |
| re-authentication             | `POST /api/user/reauthenticate`                  | 5 / 15 min per user  | Handler |
| referral check                | `GET /api/referrals/code/check/[code]`           | 10 / min per IP      | Handler |

The referral check keys on `getClientIp` (the middleware-stamped IP) and
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
| 2FA lockouts                                   | twoFactor plugin: 5 wrong codes void one challenge; 10 consecutive wrong codes pause 2FA for 15 minutes |
| Step-up                                        | Credential, factor, payout, refund and IAM changes need a proof from the last 15 minutes                |
| Hashed tokens at rest                          | Reset and verification identifiers stored as SHA-256                                                    |
| CSP                                            | Report-only to Sentry, see [security headers](../enterprise/20-iam-and-security/04-security-headers.md) |
| Turnstile on mail-sending endpoints            | See below                                                                                               |
| Per-account sign-in throttle                   | See below                                                                                               |
| Per-recipient mail cap                         | See below                                                                                               |

### Turnstile on the mail-sending endpoints

Cloudflare Turnstile guards the three endpoints that send mail to an address
the caller types in: `/sign-up/email`, `/request-password-reset` and
`/email-otp/send-verification-otp`. Sign-in has no captcha, because it sends
nothing until the password has matched, and it is the main conversion path.

- **Server.** Better Auth's own `captcha` plugin with provider
  `cloudflare-turnstile` (`lib/auth/captcha.ts`). Its `endpoints` option is
  overridden, because the plugin's default list includes `/sign-in/email`. The
  plugin runs in `onRequest`, so it applies to HTTP calls only; server-side
  `auth.api.*` calls such as the operator setup link are not affected.
- **Client.** `components/auth/Turnstile.tsx` loads
  `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
  and renders one managed widget with `appearance: "interaction-only"`, so
  most visitors see nothing. The sign-up form, the forgot-password form and
  the resend button on the verify-email page send the token in the
  `x-captcha-response` header, which is the header the plugin reads. A token
  is single-use and lives 300 seconds, so the widget is reset after every
  submit, failed ones included, and `refresh-expired: "auto"` renews an idle
  one. A form with no token yet shows `MISSING_RESPONSE` copy instead of
  sending, so it does not spend a per-IP budget slot.
- **Errors.** A missing token answers 400 `MISSING_RESPONSE`, and a rejected
  one 403 `VERIFICATION_FAILED`. Both are catalogued in
  `lib/labels/auth-errors.ts` with copy that names the usual cause (a privacy
  extension or a network filter blocking `challenges.cloudflare.com`) and
  links to support. A live region under the widget announces "Checking your
  browser…" and failures.
- **Outage behaviour: fails closed.** The plugin waits up to 10 seconds for
  Cloudflare's siteverify and then answers 500. During a Cloudflare outage,
  sign-up, password-reset requests and code resends stop; sign-in keeps
  working. The auth logger sends at most one Sentry event per message per 5
  minutes per instance.
- **Hostname check.** When `NEXT_PUBLIC_SENTRY_ENVIRONMENT` is `production`
  (Netlify's `CONTEXT` is build-time only, so it cannot be read at runtime),
  the plugin's `allowedHostnames` holds the hostname of `BETTER_AUTH_URL`, so a token
  minted on another site is refused. The plugin matches hostnames exactly, so
  deploy previews (one hostname per PR) get no hostname check, and Cloudflare's
  test keys, which report `example.com`, keep working there.
- **Configuration.** Both `TURNSTILE_SECRET_KEY` and
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` must be set. With either one unset the
  plugin is not installed and the widget is not rendered, so the two halves
  can never disagree. A production runtime without both keys boots with one
  `console.error` and one `AUTH_CAPTCHA_DISABLED` Sentry Logs warning (`Sentry.logger.warn`, which does not draw on the error quota and never opens an issue), rather than
  failing at boot: a throw in `lib/auth.ts` would take down every auth route,
  sign-in and session reads included.
- **CSP.** `https://challenges.cloudflare.com` is in `script-src` and
  `frame-src` (`next.config.mjs`). The widget talks to Cloudflare from inside
  its own iframe, so `connect-src` needs nothing.

Cloudflare publishes test keys that work on any hostname. Use them locally and
on deploy previews:

| Key    | Value                                 | Behaviour                     |
| ------ | ------------------------------------- | ----------------------------- |
| Site   | `1x00000000000000000000AA`            | Always passes (visible)       |
| Site   | `2x00000000000000000000AB`            | Always fails (visible)        |
| Site   | `3x00000000000000000000FF`            | Forces an interactive check   |
| Secret | `1x0000000000000000000000000000000AA` | Always passes validation      |
| Secret | `2x0000000000000000000000000000000AA` | Always fails validation       |
| Secret | `3x0000000000000000000000000000000AA` | Answers "token already spent" |

### Per-account sign-in throttle

`lib/auth/account-throttle.ts` slows repeated wrong passwords for one address
without handing a stranger a way to lock its owner out. It keeps two counters
per submitted address, each in a fixed 15-minute window:

| Scope                                          | Key                                                  | Waits                                          |
| ---------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| The address, from anywhere                     | `rl:acct:signin:<sha256(lower(trim(email)))>`        | 30 s from 10 failures, 2 min from 20 (the cap) |
| The address from one network prefix (/24, /48) | `rl:acct:signin:net:<sha256(email + "\|" + prefix)>` | 15 min from 40 failures                        |

- **Why two scopes.** A botnet spread over many networks can only push the
  address-wide wait to 2 minutes, which keeps credential stuffing to roughly
  25 guesses per 15 minutes per account. The 15-minute wait lands only on the
  prefix doing the guessing, so 40 wrong passwords from a stranger's network
  never lock out the owner signing in from home. The prefix is the
  middleware-stamped client IP from `lib/request-ip.ts`, cut to /24 for IPv4
  and /48 for IPv6.
- **Example.** An attacker on `203.0.113.0/24` sends 40 wrong passwords for
  `asha@example.com`. Their next try waits 15 minutes. Asha, on
  `198.51.100.0/24`, waits at most 2 minutes, and a password reset clears
  both counters for her prefix.
- **Counting.** An `INVALID_EMAIL_OR_PASSWORD` answer on `/sign-in/email`
  increments both counters. A successful sign-in, a pending 2FA challenge (the
  password matched) or a completed password reset deletes the address-wide
  counter and the caller's prefix counter. These are growing `Retry-After`
  windows, never a server-side sleep and never a permanent lock.
- **The answer.** The gate is a Better Auth `hooks.before` on the parsed
  body, so JSON and `application/x-www-form-urlencoded` sign-ins are gated
  alike, before the password is hashed. While a wait is pending it answers a
  429 that is byte-for-byte BetterAuth's own per-IP 429 (`X-Retry-After`,
  mirrored into `Retry-After`). The key is the submitted address whether or
  not an account exists, so the 429 is not an enumeration oracle.
- **Fails open.** A Redis error or a reply slower than 500 ms lets the attempt
  through and sends a throttled Sentry event (`auth:account-throttle`).

### Per-recipient mail cap

`deliver()` refuses a send when the recipient has already had 5 mails of the
same type in the last 24 hours, for the types a stranger can aim at any
address: `EMAIL_VERIFICATION`, `PASSWORD_RESET` and
`EXISTING_ACCOUNT_SIGN_UP` (`lib/email/recipient-cap.ts`). Staff
invitations are sent as `STAFF_INVITE` and capped in their own bucket, because
a forgot-password request for an operator who has not enrolled 2FA also sends
one, and a reset flood must not spend the invitation's budget. Auth mail is sent after the
response, so the endpoint cannot say whether a mail was dropped; instead the
verify-email and forgot-password pages always state the limit ("You can
request at most 5 codes a day"), which reveals nothing about the address. See
[the email README](../email/README.md).

### Enumeration safety

- **Sign-up answers one shape.** A new address, an existing one and a sign-up
  that loses the `User.email` unique race all return `{ token: null, user }`
  with the same keys (`canonicalSignUpUser` in `lib/auth/core-policy.ts`).
- **The existing owner is told, not the caller.** `onExistingUserSignUp` sends
  the "someone tried to sign up with your address" notice
  (`EXISTING_ACCOUNT_SIGN_UP`), which the per-recipient mail cap limits to 5
  per address per day.
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
  revokes every session and deletes outstanding tokens (`onPasswordReset`).
- `purge-unverified-users` deletes never-verified, credential-only consumer
  accounts with nothing attached after 7 days, freeing the address.
- Turnstile on sign-up makes scripted pre-registration expensive.

## 6. Deliberately absent

| Not built           | Why                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Captcha on sign-in  | Sign-in sends no mail and is the main conversion path; the per-account throttle covers credential stuffing          |
| Password lockout    | Lets anyone lock out any victim. Growing per-account waits capped at 15 minutes, plus the 2FA lockout for operators |
| Email codes as 2FA  | Shares a channel with password reset, so it adds little as a second factor                                          |
| Break-glass account | A standing bypass is a standing target. Operator recovery is the ADMIN 2FA reset                                    |
| Account-state hints | Graded disclosure is an enumeration oracle                                                                          |

## 7. Accepted risks

| Risk                 | What can happen                                                                                                                                  | Why it is accepted                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TOTP replay window   | The twoFactor plugin verifies ±1 step with no used-code guard, so a code stays valid for about 90 s and can complete a second challenge          | The password is still required, and the per-challenge budget (5 codes) plus the account lock (10 straight failures, 15 minutes) bound guessing. Passkeys are the phishing-resistant answer |
| 2FA lockout as a DoS | Anyone holding an operator's password can spend 10 wrong codes, restarting challenges, and pause that operator's 2FA verification for 15 minutes | It needs the password, and the operator gets a lockout email, so the attempt is visible                                                                                                    |

## 8. Adding a limit

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
- **SSO budgets of 20 and 30 per 15 minutes**, which an enforce-on sweep of a
  whole office behind one NAT address could exhaust; raised to 300 and 1000.
- **First-hop `x-forwarded-for` keys** on the referral check: client-controlled
  on Netlify, so the limit was bypassable. Use `getClientIp`.
- **Node-side `x-nf-client-connection-ip` or `x-forwarded-for` keys:** every
  API call passes through the edge middleware first, so inside the function
  both name the edge function's egress address, one per deploy. Every auth
  limit and the per-prefix lock were shared by all visitors. Node code now
  reads only the stamp middleware sets.
- **Per-IP-only auth limits:** every auth budget was keyed on the client IP, so
  a proxy pool got a fresh budget per address. Turnstile, the per-account
  throttle and the per-recipient cap now key on something else.
- **A 15-minute wait per address from anywhere:** a stranger could re-arm it
  with 40 wrong passwords and keep the owner out. The long wait now applies
  per network prefix only.
- **Hourly mail caps in `lib/auth.ts`** (`rl:mail:{reset|verify}`, 3 per hour)
  and the `existingAccountNoticeLimiter` (2 per hour): replaced by the one
  daily cap inside `deliver()`.
