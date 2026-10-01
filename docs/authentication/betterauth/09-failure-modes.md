# Failure modes

| Field | Value |
|---|---|
| Status | Stable — the matrix is the contract; the "should" column is the open backlog |
| Audience | All engineers, on-call |
| Last reviewed | 2026-09-29 |
| Source files | `lib/labels/auth-errors.ts`, `lib/auth/attempts.ts`, `lib/auth/sign-in-attempt-hooks.ts`, `lib/auth-session-lookup.ts`, `lib/rate-limit.ts`, `lib/auth/session-read-guard.ts`, `next.config.mjs`, `netlify.toml` |

## 1. Background

Authentication is a small amount of our code standing on top of a lot of other
people's. Postgres, Upstash, Resend, Novu, two payment gateways, Stream, Sentry
and Netlify's own function runtime are all between a person typing a password
and a cookie arriving. Every one of them has failed here, and each failed in a
way that produced a *sentence* rather than a diagnosis.

This document is the cross-service matrix for the auth-relevant subset. It exists
because the per-subsystem docs each own their half and none of them owned the
seam: the moment a failure crosses from one service into another, the sentence
the customer reads is decided by whichever side noticed last, and the person on
call has to reconstruct the rest.

Two columns matter more than the rest:

- **Today** is what the code does, and where a row is marked *fixed* the fix is
  in this branch and the row is kept because the next reader needs to know the
  failure existed, not because it can recur.
- **Should** is the backlog. It is not aspirational: every row in it names a
  change that is small, specified, and owned by nobody yet.

## 2. Scope

| In scope | Out of scope |
|---|---|
| Failures a signed-out or signing-in user can hit | Money-path failure modes — see [`docs/finance`](../../../.claude/skills/finance/SKILL.md) and [`docs/payments/`](../../payments/) |
| The user-visible sentence each failure produces | Business refusals — see [`docs/errors/01-refusals.md`](../../errors/01-refusals.md) |
| Which of our files owns each answer | The full rate-limit table — see [`04-rate-limiting.md`](./04-rate-limiting.md) |
| | Streaming media quality — see [`docs/stream/12-error-handling.md`](../../stream/12-error-handling.md) |

## 3. Where to start

| # | Section | Reading time |
|---|---|---|
| 1 | [The matrix](#4-the-matrix) | 15 min |
| 2 | [The three rules the matrix encodes](#5-the-three-rules-the-matrix-encodes) | 5 min |
| 3 | [Postgres](#6-postgres) | 5 min |
| 4 | [Upstash Redis](#7-upstash-redis) | 8 min |
| 5 | [Email and notifications](#8-email-and-notifications) | 5 min |
| 6 | [The platform](#9-the-platform-netlify) | 8 min |
| 7 | [The auth layer itself](#10-the-auth-layer-itself) | 10 min |

## 4. The matrix

Fixed = the fix is in this branch; the row is kept as history. Open = named in
the "should" column and not yet implemented.

| # | Failure | What the user sees today | What the code does today | What it should do | Owner |
|---|---|---|---|---|---|
| 1 | **Upstash Redis unreachable** | Nothing. Every limit is silently not enforced. | `applyRateLimit` catches and returns `null` — fails **open**. `rateLimitStoreDegraded` latches; `x-rate-limit-degraded` is stamped on the request. `readSignInAttempt` returns `NO_ATTEMPT_INFO` (no lockout, **no** disclosure). The user signs in normally. | Escalate to **mandatory captcha** on the credential endpoints when `x-rate-limit-degraded` is present, and show a `degraded-auth` banner. Fail-open stays — the alternative is a self-inflicted outage. The header and the predicate already exist for exactly this consumer; nobody reads them. | `lib/rate-limit.ts` (`RATE_LIMIT_DEGRADED_HEADER`); the captcha gate is configured in `lib/auth.ts:616`. **Open.** |
| 2 | **Upstash plan quota exhausted** (monthly command ceiling; 500K on the free tier, hit twice) | The same as #1, for longer, and with no signal that it is a quota rather than an outage. | Identical to #1 — a quota rejection and a network failure are the same thrown error to the limiter. The amplification is real: one cap became **~4,000 Sentry events in ~25 h** before `captureThrottled` landed. | Same as #1, plus the quota shape as a named pattern: distinguish *quota exhaustion* (deterministic, will not clear on its own, escalate now) from *transport failure* (transient, retry). Today both are one `catch`. | `lib/observability/throttled-capture.ts` (the throttle), `docs/upstash/00-pricing-overview.md` (the ceiling), `docs/enterprise/50-operations/04-monitoring.md` (the `>20K/day` abuse signal). **Open:** the pattern itself. |
| 3 | **Resend down, or a rejected API key / unverified domain** | Nothing, at first. Sign-up "succeeds"; no verification mail ever arrives. | `deliver()` throws inside its own try block, so the message dead-letters into `FailedEmail` at `PENDING` with the reason in `lastError` rather than being dropped. The retry worker replays it. **This is the correct behaviour.** | Sign-in must detect *unverified address with no credential account* and offer a resend in place of the collapsed password error — that state is otherwise indistinguishable from a wrong password. Separately, keep the existing `PENDING` drain. | `lib/email/deliver.ts`, `jobs/email/retry-failed-emails.ts`, `docs/notifications/06-engineering-log-2026-09-14-email-resend-outage.md`. **Open:** the sign-in detection. |
| 4 | **PG pool exhausted (`PG_POOL_MAX=1`)** | "We couldn't reach the sign-in service. Nothing was changed. Please try again in a moment." A 503 with `Retry-After`. | `lookupSession` returns `{ kind: "failed" }` rather than `null`; page guards throw `SessionLookupFailedError`; the boundary retries and **never signs out**. The code is `SESSION_LOOKUP_FAILED`, which the catalog maps to `UNREACHABLE`. **Already correct, and this is why the tri-state exists.** | Keep as is. Surface the 503's `Retry-After` as a countdown in the UI rather than only inside the sentence. | `lib/auth-session-lookup.ts` (#1716), `lib/labels/auth-errors.catalog.ts` (`SESSION_LOOKUP_FAILED`), `.claude/skills/maintenance/references/serverless-gotchas.md`. **Open:** the UI countdown. |
| 5 | **A global-client read inside a `$transaction`** | A hang, then a bare platform 500 with no error boundary. | Structurally impossible on the auth path today, and structurally *possible* on any money path: with one connection per instance, a read on the global `prisma` inside an open transaction waits for the connection the transaction holds. | Nothing to add. It is a rule, and the rule is in the finance doctrine. | `.claude/skills/finance/references/doctrine.md` §`PG_POOL_MAX=1`; issue #1435. |
| 6 | **Netlify cold-instance stall (~25–28 s before any app code runs)** | The client sees `status 0`. "We couldn't reach the sign-in service." | Correct, and deliberately so — a thrown fetch, a 5xx and the tri-state's `failed` case all map to `UNREACHABLE`, which says *nothing was changed* and offers a retry. The wording matters here more than anywhere else: the customer's password was fine. | Add a zero-import `/api/auth/ok` probe to the keep-warm set (`netlify/functions/keep-warm.mts`, three parallel pings every four minutes against `/api/perf/probe-bare`), and allow **one** bounded client retry on a `status 0`. One, because the stall is billed as wall-clock duration and a retry loop is a cost multiplier. | `netlify/functions/keep-warm.mts`, `docs/perf/2026-09-15-cold-start-isolation-results.md`, `.claude/skills/deployment/netlify/platform-limits.md` (Netlify ticket #1112198: platform-side, no fix in flight, no provisioned concurrency on any plan). **Open.** |
| 7 | **Netlify function timeout** (60 s Lambda execution; ~37–38 s edge receive-timeout before streaming starts) | A platform 500 with an empty body, or a hung spinner. | Nothing in our code can distinguish it; it is not an HTTP response we produced. | Keep the diagnostic at the edge (the keep-warm probe's own timing is the detector) and treat every auth page's `status 0` / 5xx branch as this until proven otherwise. | `netlify.toml`, `.claude/skills/deployment/netlify/platform-limits.md`. |
| 8 | **Netlify reclaims an idle instance after ~5 min in `ap-southeast-1`** | The first request after idle pays the full cold stall. | Same as #6. It is why the keep-warm interval is **four** minutes and not five — Netlify confirmed a five-minute ping races the reclaim window. | Already handled; listed so the four-minute interval is not "simplified" to five. | `netlify/functions/keep-warm.mts`, `.claude/skills/maintenance/references/cron-ticker.md`. |
| 9 | **A required env var is missing or reclaimed** (a Netlify context without the key, a half-finished rotation) | Depends entirely on which var. `AUTH_CONFIG_ENCRYPTION_KEY` missing → `SSO_PROVIDER_MISCONFIGURED` for every SSO org. `BETTER_AUTH_SECRET` missing → every session unverifiable. | Variable, and mostly because the modules fail with a *named* reason rather than a generic one: `SecretPayloadError` carries a closed `SecretPayloadFailure` set (`key_unavailable`, `envelope_malformed`, `auth_failed`, `payload_not_json`) so a missing key is not flattened into "wrong key", and the admin is not sent to rewrite a working IdP config. | Keep the closed failure set. Add an env-presence assertion to the build, not to the request path. | `lib/sso/secret-crypto.ts`, `docs/enterprise/50-operations/07-required-secrets.md`. |

| 10 | **`trustedOrigins` misconfigured on a deploy preview** | "This sign-in request was blocked. Our security policy stopped the request before it reached the sign-in service. If you're on a preview deployment, use the main site's address instead." | **Fixed.** A code-less 401/403 from `/api/auth/*` maps to `REQUEST_REJECTED` rather than falling through to `GENERIC[flow]`. The old behaviour was "Something went wrong on our side" for a request with a correct password. | Keep, and add the deploy-preview case to the runbook's origin list — the copy already names it, the runbook does not yet. | `lib/labels/auth-errors.ts` (`copyForStatus`), `docs/enterprise/50-operations/03-runbooks.md`. **Open:** the runbook row. |
| 11 | **IdP unreachable at sign-in** | "We couldn't reach your identity provider. The organisation's sign-in service didn't answer. Wait a minute and try again." (`SSO_PROVIDER_UNREACHABLE`) | **Fixed.** It used to be a raw `fetch failed` string in a toast. The catalog entry is `action: "retry"`. | Add a **"use your password instead"** escape hatch, but only for domains that have both a password path and an `enforceSSO = false` policy. Under `enforceSSO` there is no password path, so the escape hatch does not exist and the copy must not offer it. | `lib/sso/signin-with-toast.ts`, `lib/labels/auth-errors.catalog.ts`. **Open:** the escape hatch. |
| 12 | **OIDC discovery at login (the pre-registration fix)** | Was: a failed sign-in minutes or days after the admin believed setup was done. | **Fixed.** `discoverOidcConfigForTenant` runs at registration and persists `authorization_endpoint`, `token_endpoint`, `jwks_uri`, so `needsRuntimeDiscovery` is false on the sign-in path. A bad IdP is now rejected while the admin is still looking at the form. | None. | `lib/sso/oidc-discovery.ts`. |
| 13 | **SAML config without `spMetadata`** | Was: `TypeError: Cannot read properties of undefined (reading 'metadata')` — an empty-bodied 500 on both the sign-in path and the SP-metadata path. **Every SAML provider this app had ever registered was unable to sign anyone in.** | **Fixed.** `buildStoredSamlConfig` always writes `spMetadata: {}`, which takes Better Auth's `SPMetadata(...)` branch so the ACS location and entity ID are derived from the provider slug. `callbackUrl: ""` is written as falsy on purpose so every ACS read falls through to that derivation. | Keep both. See `docs/enterprise/20-iam-and-security/01-sso-and-authentication.md` for why this must not be "simplified" back. | `lib/sso/stored-config.ts`, `lib/sso/provider-schemas.ts`. |
| 14 | **SAML signing certificate expired** | Nobody, in the product. The sign-in breaks. | The daily cron (`jobs/cleanup/sso-cert-expiry-alert.ts`) audits `SSO_CERT_EXPIRING` at `WARN` (≤30 d), `CRITICAL` (≤7 d) and `EXPIRED`, dedupes inside 20 h, and fires a best-effort Novu bell to OWNERs. Nothing in the product tells the org. | A **badge on the org SSO settings page** driven by the same `notAfter` the cron parses — `validateSamlCert` is already the shared parse helper, and the `domain-check` probe already reads the cert. The operator who can act is the person looking at the settings page, not an audit row. | `jobs/cleanup/sso-cert-expiry-alert.ts`, `lib/sso/provider-schemas.ts`. **Open.** |
| 15 | **SCIM bearer token expired or revoked** | A 401 with `{"detail":"Token has expired"}` and no `scimType`. | Correct per RFC 7644 §3.12 — the envelope is right. The wording is what is wrong: Okta, Azure AD and OneLogin render `detail` directly to the provisioning admin, and a string that does not name the fix reads as a broken integration. | A distinct `scimType` per cause (`noTarget` for a revoked token) and an operator-shaped `detail`, so Okta renders something a human can act on. | `lib/scim/auth.ts`, `lib/scim/errors.ts`. **Open.** |
| 16 | **SCIM-deactivated user, org has `enforceSSO = true`** | **A successful login to an empty dashboard.** | The user's `Membership` is inactive, so every org-scoped query returns nothing. The session is valid, the account is not suspended, and the failure is visible as "the product is broken". | A pre-session `SCIM_USER_NOT_ACTIVE` — the code and its copy ("Your directory account is no longer active…") are already in the catalog; nothing mints it. This is the **account-state** half of the graded disclosure and belongs in the same place as the sign-in classifier, not in a page guard. | `lib/labels/auth-errors.catalog.ts` (`SCIM_USER_NOT_ACTIVE`), `lib/sso/enforce-session.ts`. **Open.** |
| 17 | **A bulk-imported member's invitation link** | 410, forever. | **Fixed.** The token the bulk path emitted was the `orgId`, not an invitation id, so every such link 410s. The invariant now: **the value in an invite link is an invitation id, and nothing else.** | Keep, and record the invariant where a bulk import is written. | `app/api/organizations/invitations/accept/route.ts:94` (the 410), `lib/rate-limit/policies.ts` (`INVITE_ACCEPT`, whose `token` dimension is defined as an *invitation id*). |
| 18 | **React `cache` unavailable in the process** | Nothing visible, until dashboard TTFB climbs and a page starts returning the pool-exhaustion 503 of #4. | Correct-but-slow: every guard in a render re-runs `getSession` and the `customSession` Prisma enrichment. `lib/auth/session-read-guard.ts` now reports it **once per process**, carrying `netlify: true|false` and the resolved React version so a one-shot cron process (where unmemoized is *correct*) is distinguishable from the RSC function (where it is a live defect). | Nothing more. This row is why the guard exists: the rendered output is byte-identical either way, so no test would ever have caught it. | `lib/auth/session-read-guard.ts`, `lib/auth-server.ts`. |
| 19 | **`markExpected` never called** | Nothing user-visible. Expected auth errors look like faults in Sentry. | `lib/observability/expected.ts` defines the marker and `sentry.shared.config.ts` honours it in `beforeSend`, so it downgrades a capture to a warning instead of a page. **No call site in the auth path stamps an error.** | Stamp the expected auth failures at their source — a `SESSION_LOOKUP_FAILED` boundary throw, a deliberately-refused SSO veto, a `SecretPayloadError` behind a 200. Each is a modelled outcome and each currently pages. | `lib/observability/expected.ts` (FAMILIARISE_WEB-10). **Open — the single highest-leverage item in this table.** |
| 20 | **Rate limit: `/forget-password` vs `/request-password-reset`** | Nothing, ever, because the route ran unthrottled for the whole life of the app. | **Fixed.** The middleware named `/api/auth/forget-password`, a path Better Auth has never had. The real route is `/api/auth/request-password-reset`. The entire forgot-password flow — the endpoint that mails unlimited reset links and turns its response into a batch oracle for which addresses hold accounts — had no budget. `lib/rate-limit/policies.ts` now owns scope, window, dimensions and rationale in one declaration, `middleware.ts` can only name a scope, and a policy declared but never matched at the edge logs an error at boot. | The **rule**: a limiter's identity, its paths and the scope it reports must be one declaration, not three pieces of text. The bug was invisible *because* those three were unrelated. | `lib/rate-limit/policies.ts`, `middleware.ts` (`POLICY_ROUTES`), `docs/authentication/betterauth/04-rate-limiting.md`. |
| 21 | **Captcha / Turnstile unavailable** | "The security check didn't load. Refresh the page and try again in a moment." (`CAPTCHA_SERVICE_UNAVAILABLE`) | Correct copy for a provider outage. Note the asymmetry worth preserving: a **failed** check is "Please confirm you're human" and a **missing** check is "Please complete the check" — they are separate codes and a page that conflates them tells a real user they are being treated as a bot. | None. | `lib/labels/auth-errors.catalog.ts`, `lib/auth.ts` (`captcha`, registered only when `TURNSTILE_SECRET_KEY` is set). |
| 22 | **Novu unreachable** (in-app bells) | No bell. The action that triggered it succeeded. | Subscribers sync best-effort; bells are `after()`-staged and re-driven by sweeps. The 504 case is the one exception `docs/errors/01-refusals.md` calls out as a *genuine* failure rather than a refusal. | None for auth. | `lib/novu/`, `docs/notifications/`. |
| 23 | **Razorpay or Stripe unreachable** | "Payment is temporarily unavailable." | The order is not created; nothing is held; a webhook that arrives late is the sweep's problem, not the request's. | None for auth. | `docs/payments/`, `.claude/skills/finance/SKILL.md`. |
| 24 | **Stream (chat / video) unreachable or token mint fails** | The meeting surface refuses to connect; the session and the account are fine. | Separate provider, separate auth story. | None for auth. | `docs/stream/12-error-handling.md`. |
| 25 | **Sentry unreachable or over quota** | Nothing — which is the failure. | `sendDefaultPii: false` and the `throttled-capture` shared window exist because the amplification risk is real: one Upstash cap became ~4,000 Sentry events in ~25 h before the throttle landed. | Treat Sentry's health as load-bearing for the auth subsystem's diagnosability, not for its availability. | `sentry.shared.config.ts`, `lib/observability/throttled-capture.ts`, `docs/observability/sentry/`. |
| 26 | **Better Auth swallows an endpoint exception into an empty 500** | A bare 500 with no body, on the auth surface. | The auth logger forwards every `error`-level line to Sentry, so the outage is at least visible. Empty-body 500s were the failure mode audit Phase A.2 was written to kill, and the SAML `spMetadata` bug (#13) was one of them. | Keep forwarding the logger; keep refusing to surface a raw message. | `lib/auth/auth-logger.ts` (#1856), `lib/labels/auth-errors.ts`. |
| 27 | **An error code the catalog has never heard of** | A generic per-flow sentence. Never, because it does not compile. | The union is closed and the catalog is a `Record<AuthErrorCode, AuthErrorCopy>`, so a Better Auth minor that adds a code fails `tsc` in CI. | None. This is the row the whole catalog exists to make unreachable. | `lib/labels/auth-error-codes.ts`, `lib/labels/auth-errors.catalog.ts`. |
| 28 | **A code *we* mint that is not in the union** | The generic per-flow sentence for that flow. | The closed union is a compile-time guarantee about `AuthErrorCode`; it cannot see a string that never joined it, and `humanizeAuthError` normalises it to `null`. The one known case, `INVITATION_REVOKED`, went with the staff invitation flow. | Mint only codes in `AppAuthErrorCode`. | `lib/labels/auth-error-codes.ts`. |
| 29 | **A staff member without 2FA on a privileged surface** | 428 with `X-Auth-Action: enroll-2fa`; back-office pages redirect to `/auth/two-factor/setup`. | `requireApiAuth` reads `twoFactorEnabled` from the session payload (rebuilt per request; the cookie cache is off). 428 rather than 403 is deliberate: 403 says the door is shut forever, 428 plus the action header names the next step. There is no header-based exemption. | Open item 4 in [`04-errors.md`](./04-errors.md): the `error` string is hand-written rather than read from `AUTH_ERROR_COPY`. | `lib/auth-helpers.ts` (`twoFactorPrecondition`), `lib/auth-guard.ts` (`requireOperator`), [`08-staff-onboarding.md`](./08-staff-onboarding.md#2-sign-in-and-mandatory-2fa). |

## 5. The three rules the matrix encodes

Twenty-seven rows, three rules.

### Rule 1 — Fail open on availability, fail closed on disclosure

Rows 1, 2 and the Redis half of the lockout. A Redis outage must not lock every
paying customer out of their own account, so the limiter fails open. It must
also not hand an enumeration oracle to whoever knocked Redis over, so
`readSignInAttempt` returns `NO_ATTEMPT_INFO` — `lockedUntil: null`,
`unlocked: false` — which is *both* "no lockout" and "no disclosure".

Those are opposite directions and they are deliberate. The missing half is that
fail-open leaves a **silent** hole on exactly the credential endpoints where the
human at the keyboard is the last remaining line, which is why
`RATE_LIMIT_DEGRADED_HEADER` exists and why "degrade toward a second line, not
toward open" is written into its docblock. The header ships; no consumer reads
it.

### Rule 2 — Never guess at the platform's fault from the customer's symptom

Rows 4, 6, 7, 10, 26. A 5xx is not "something went wrong on our side"; it is
"We couldn't reach the sign-in service. **Nothing was changed.**" A 401 from
`/api/auth/*` is not a wrong password; it is a request that never reached a
handler. Getting this wrong costs a support conversation and, on row 4, costs a
signed-in user their session — which is the one thing `lookupSession`'s tri-state
was built to prevent.

### Rule 3 — A refusal is not a fault, and a fault that is a refusal is a bug

Rows 3, 14, 15, 19. `FailedEmail` at `PENDING` is a correct answer to a Resend
outage, not a lost email. The empty Sentry event on a deliberate refusal is not
a missing report, it is an unwired `markExpected`. The 410 on a stale invite
link is not a bug once the token invariant holds.

The reason this is a rule and not a preference: the four cases look identical in
a log, and the one that *is* a fault (#19, expected errors paging on-call) is the
one that is hardest to spot precisely because everything around it is behaving
correctly.

## 6. Postgres

Production runs `PG_POOL_MAX=1` on **every** context — production, deploy
preview and branch deploy alike. Each function instance holds exactly one
`pg.Pool` client, so concurrent Prisma queries serialise instead of overlapping.
Widening it is a capacity question about Supabase pooler limits across
concurrent instances, not a config tweak; it is issue #1117.

The auth consequence is row 4, and it is the reason the tri-state exists.
Better Auth's `customSession` endpoint wraps the core session lookup in
`.catch(() => null)`, so an adapter failure on a **valid** cookie came back as
"no session" and the caller answered **401 to a signed-in user** — the customer
was signed out by a database hiccup, with no error boundary in between. The
zero-argument `getSession` cannot tell those two answers apart, so
`lookupSession` adds a third: a null *with* a session cookie is ambiguous, and
one indexed read of the `Session` row settles it. A live row means the lookup
did not complete; no row means the session is gone.

The extra read runs only on the null path, which is rare for a signed-in caller,
and the tri-state also has to let Next's control-flow throws through — a
`NEXT_REDIRECT` carries a string `digest` and must reach the framework; a
database fault carries none, and that difference is the test between them.

Row 18 is the second Postgres row and it is the same shape. Losing the session
memo is not a correctness bug, it is a *load* bug: N guards on one page become N
serialised acquisitions of the single connection, and pool exhaustion is the
direct consequence.

## 7. Upstash Redis

Upstash is the only shared state in the auth path, and it is where the two worst
rows live.

**The quota is monthly, not daily.** The free tier's binding constraint is a
~500K command ceiling per month, and it has been hit — twice. `docs/upstash/00-pricing-overview.md`
puts the current burn at ~90K commands/month at 1,500 MAU, so the ceiling is
about 8,300 MAU away, and the operational signal to watch is a **daily** count
above 20K. The lesson from the two hits was cost-shaping, not alert-raising:
`reconcile-payment-status` and `reconcile-orphaned-confirmations` moved from the
five-minute ticker to the fifteen-minute slot on 2026-09-25 (#1822 Q-3), the
largest single cut to Redis-command cost, and six sweeps run on the
fifteen-minute slots rather than every tick (#1686) because a five-minute tick
across twelve parallel targets is a twelve-way cold burst billed as duration.

**The two failures are indistinguishable today.** A quota rejection and a network
timeout both arrive as a thrown error inside `applyRateLimit`'s `catch`. That
matters because the right response differs: a transport error is transient and
the existing fail-open plus retry is correct, while a quota exhaustion is
deterministic, will not clear on its own, and is the moment to escalate to a
second line rather than wait. Naming that distinction — a `INFRA_TRANSIENT_PATTERNS`
list of failure shapes that are *expected* to be transient, so a quota rejection
is not silently filed under one — is the smallest open item in this table and
the one most likely to be got wrong by a future reader who adds a `catch`.

**Account keys are digests, never addresses.** Redis keys are plaintext at rest
and visible in `MONITOR`; an address list living in Redis is a customer list
living in Redis. `accountAttemptKey` (`sha256(lower(trim(email)))`) and
`accountKey` in the policy table implement the same algorithm, and
`tokenKey` is domain-separated with a `token:` prefix so a reset-token digest
can never answer for an address digest. The two implementations of the address
hash are written twice because `lib/auth/attempts.ts` is `node:crypto` and the
policy table is in the Edge graph; the mitigation is that the policy table
exports `accountKey` and callers import it rather than re-deriving.

## 8. Email and notifications

The 2026-09-14 Resend outage had **three independent causes** producing one
symptom, and the shape is the lesson: an invalid API key deployed to four places,
a `from:` domain the company has never owned, and an owned domain with no DKIM,
SPF or DMARC. Fixing any one of the three would not have restored mail.

What the current design gets right is the failure path. `deliver()` is the single
send core behind all eleven senders; `EmailNotConfiguredError` is thrown
*inside* `deliver()`'s own try block so a missing key dead-letters into
`FailedEmail` instead of returning early and dropping the message; a
content-hash Idempotency-Key deduplicates for 24 hours across the whole
five-step retry ladder; and a terminal failure dead-letters on the first attempt
with a paging Sentry message.

One nuance about row 3's "should". The `FailedEmail` status machine is
`PENDING → RETRY → SENT | DEAD_LETTER`, and the retry worker selects
`{ status: "PENDING" }` alongside `RETRY`, so a row created during the outage is
picked up by the existing drain — a `PENDING`-drain cron is **not** missing.
What is missing is the *other* half: a person who signed up during the outage and
never received a link comes back to a sign-in page that cannot tell "you have no
account" from "you have an account and the password you tried belongs to nobody".
That is the graded-disclosure classifier's job (it already computes
`unverified` and `no_password`) and it is not wired to Resend's state.

## 9. The platform (Netlify)

Three separate limits, and the difference between them is the whole story of row
6.

| Limit | Value | Who confirmed it |
|---|---|---|
| Lambda execution | 60 s | Netlify's documented limit |
| Edge receive-timeout (before streaming starts) | ~37–38 s, **not configurable on Pro** | Netlify support, ticket #1112198 |
| Cold-instance stall | ~24–28 s before *any* application code runs, worst under concurrent creation | Measured here (12/12 at 29.5–31.5 s), confirmed platform-side by the vendor |

Netlify's engineer attributed the stall to serialised initialisation when
several Lambda environments are created at once, and confirmed that **no plan,
including Pro, offers provisioned concurrency or minimum instances**. Netlify
also confirmed requests bound for *warm* instances are held at the edge for the
same window during a burst.

Three things that were measured and are dead, so nobody re-opens them: raising
handler memory (2048 MB applied and verified via the runtime API, 11/12 still at
35.9–37.6 s, reverted in `08b10ce4` — and because `memory` and `vcpu` scale
together this tested CPU-share too), a lazy-init build (reproduced the stall at
full strength the next day, so application init is not the driver), and a
request-time retry (reverted inside #1123 — the next attempt genuinely succeeds
in 327–340 ms, but retrying per read doubles the query count on a page that
issues four, and with `PG_POOL_MAX=1` that serialises them and pushes the render
toward the function ceiling, where the response is a bare platform 500 with no
error boundary — strictly worse than a fast 500).

One deployment foot-gun that belongs in this table because it fails *silently*:
`@netlify/plugin-nextjs` v5 generates a single function named
`___netlify-server-handler`, and the classic `___netlify-handler` /
`___netlify-odb-handler` names in `netlify.toml` match nothing. A `node_bundler`
/ `included_files` / `external_node_modules` block is **silently ignored**.

## 10. The auth layer itself

### The catalog is the anti-generic

Row 27 is the row the whole subsystem was built for. The previous catalog was
`Record<string, AuthErrorCopy>`, which silently accepted every unhandled code
and fell through to a generic sentence — so every code Better Auth ever added
became a support ticket nobody could diagnose. The union is now closed and the
catalog is exhaustive over it, so the same class of change is a **build
failure**. See [`04-errors.md`](./04-errors.md) for the mechanism.

### The deployment-rejection rule

Row 10 deserves its own paragraph because "wrong password" was the wrong answer
in a way that mattered. A 401 or 403 out of `/api/auth/*` means the request
never reached a handler — a `trustedOrigins` or CSRF rejection at the edge. There
is no account, no password and no code to speak of. Answering it with
`GENERIC[flow]` told a correct password that something went wrong on our side,
and gave support nothing to look for. `REQUEST_REJECTED` names the actual cause
and names the deploy-preview case in its copy, because that is the case that
actually happens to the operator who opens a preview.

### The graded disclosure is the reason a bug is survivable

Row 16 is the sharpest one. A SCIM-deactivated user on an `enforceSSO` org gets
a **successful** login and an empty dashboard: the session is valid, the account
is not suspended, and the only symptom is that the product looks broken. The
copy for it — "Your directory account is no longer active. Your identity
provider says this account is deactivated. Ask an administrator to re-activate
it." — is already in the catalog. Nothing mints it.

It belongs in the same place as `classifyAccountState`, not in a page guard,
because the guard would produce the sentence while the session was already
issued, and every surface behind the guard would need its own copy.

### The graded disclosure is also why the account keys are hashed

Both halves of `readSignInAttempt`'s failure mode depend on a key that is safe
to put in Redis. An address is not: Redis is plaintext at rest and visible in
`MONITOR`, and the same reasoning is why this project holds
`sendDefaultPii: false` in Sentry. `sha256(lower(trim(email)))` also makes the
counter *per account* rather than per string — without the trim and lowercase,
`Bob@x.com` and `bob@x.com ` are two budgets for one account and the second is
free.

### The lockout counts failures, never successes

Worth stating because it is the invariant a future "optimisation" breaks.
`clearSignInAttempts` runs on a *successful* sign-in, which is a reset. A
clear-on-every-attempt implementation would let an attacker reset the budget by
interleaving one success with each guess. And `recordSignInFailure` is called
from exactly one branch — a genuine `INVALID_EMAIL_OR_PASSWORD` or
`INVALID_PASSWORD` — because counting a captcha rejection, a rate-limit refusal
or a validation error as a failed password would hand an attacker who cannot
authenticate at all a denial of service against real customers.

## 11. Open items, in the order they would be worth doing

| # | Item | Row | Cost |
|---|---|---|---|
| 1 | Call `markExpected` at the auth boundaries that are refusals, not faults | 19 | One import per site |
| 2 | Add `INVITATION_REVOKED` to `AppAuthErrorCode` and the catalog | 28 | One type member, one record row, one test |
| 3 | Escalate to mandatory captcha when `x-rate-limit-degraded` is present, and show a `degraded-auth` banner | 1 | The header and the predicate already ship |
| 4 | Pre-session `SCIM_USER_NOT_ACTIVE` | 16 | The classifier already computes the state |
| 5 | Read the 2FA refusal's sentence from `AUTH_ERROR_COPY` instead of a hand-written `error` string | 29 | One call site; the catalog row already exists |
| 6 | Surface the 503 `Retry-After` as a countdown | 4 | UI only |
| 7 | `scimType` for a revoked SCIM token, operator-shaped `detail` | 15 | `lib/scim/errors.ts` already takes the argument |
| 8 | Sign-in detects "unverified, no credential account" and offers a resend | 3 | Two indexed reads behind an already-unlocked disclosure |
| 9 | `/api/auth/ok` in the keep-warm set; one bounded retry on `status 0` | 6 | A probe route plus a one-line constant |
| 10 | SAML expiry badge on the org SSO settings page | 14 | The cert parse is already shared |
| 11 | `INFRA_TRANSIENT_PATTERNS` — the transient/structural failure split | 2 | A list, and the discipline to use it |
| 12 | "Use your password instead" escape hatch, gated on `enforceSSO = false` | 11 | One conditional affordance |
| 13 | Deploy-preview origin case in the runbook | 10 | A row |

## 12. Related docs

- [`04-errors.md`](./04-errors.md) — the catalog, the closed union, the
  resolution order and the tiered-disclosure threat model.
- [`04-rate-limiting.md`](./04-rate-limiting.md) — the policy table, and why the
  `/forget-password` prefix ran unthrottled for the life of the app.
- [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md) — the hook mechanism
  the lockout and the disclosure verdict ride on.
- [`../../enterprise/20-iam-and-security/01-sso-and-authentication.md`](../../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — the SAML `spMetadata` fix, cert rotation and break-glass.
- [`../../notifications/06-engineering-log-2026-09-14-email-resend-outage.md`](../../notifications/06-engineering-log-2026-09-14-email-resend-outage.md)
  — row 3, and the three causes that produced one symptom.
- [`../../upstash/00-pricing-overview.md`](../../upstash/00-pricing-overview.md)
  — the ceiling row 2 runs into.
- [`../../perf/2026-09-15-cold-start-isolation-results.md`](../../perf/2026-09-15-cold-start-isolation-results.md)
  — the zero-import probe that isolates row 6 from application code.
