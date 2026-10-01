# Authentication — BetterAuth

This folder is the new-developer onboarding surface for everything
authentication-related. Read top-to-bottom; the files build on each
other.

| Order | File | What it covers |
|---|---|---|
| 1 | [`01-architecture.md`](./01-architecture.md) | BetterAuth setup, plugin chain, session model, no-JWT rationale, database hooks, customSession hot path. |
| 2 | [`02-middleware.md`](./02-middleware.md) | Request lifecycle: Edge Runtime, route classification, cookie-only auth check, maintenance mode integration. |
| 3 | [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md) | Session lifecycle, the three database hooks, membership bridge, auth-guard vs auth-helper distinction. |
| 4 | [`04-errors.md`](./04-errors.md) | **The error system**: the closed `AuthErrorCode` union and why a new BetterAuth code is a *build failure*, `humanizeAuthError`'s resolution order, the 429/`Retry-After` rewrite, why a 401 from `/api/auth/*` is a deployment rejection, and the tiered-disclosure rule with its threat model. Read before changing anything a user reads. |
| 5 | [`04-rate-limiting.md`](./04-rate-limiting.md) | The policy table (`RATE_POLICIES` → `POLICY_ROUTES` → `RATE_LIMIT_RULES`), the full budget matrix, fail-open posture, the degraded-store header, and how to add a limiter. |
| 6 | [`05-testing.md`](./05-testing.md) | SSO unit tests, `verify-sso-invariants.sh` static checks, how to write new auth tests. |
| 7 | [`06-ci-deployment.md`](./06-ci-deployment.md) | GitHub Actions CI pipeline, SSO cert expiry cron, Docker dev/prod, Netlify, env vars, secret rotation. |
| 8 | [`sso/README.md`](./sso/README.md) | Enterprise SSO in depth — SAML/OIDC, enforcement layers, domain claims, provider schemas, PKCE, cert rotation. |
| 9 | [`oauth/README.md`](./oauth/README.md) | OAuth providers (Google, GitHub), account linking, how to add a new provider. |
| 10 | [`07-email-verification.md`](./07-email-verification.md) | Verification links, their TTLs, and the resend paths. |
| 11 | [`08-redirects-and-navigation.md`](./08-redirects-and-navigation.md) | **The anti-flicker contract**: auth redirect rules (`replace` not `push`, idempotency refs, force-fresh destination checks, `safeSameOriginPath`, server-side dashboard entry redirects). Read before touching any redirect. |
| 12 | [`08-staff-onboarding.md`](./08-staff-onboarding.md) | **How an admin is bootstrapped and how staff join**: why domain is never the authorisation key, why an admin cannot be self-created, the single-use email-bound token, and why mandatory 2FA is enforced in the guard rather than at session creation. Contract and invariants, not implementation. |
| 13 | [`09-sessions-devices.md`](./09-sessions-devices.md) | **The device list**: the select allowlist, the revocation choke point, what each sign-out scenario does and how fast other devices notice, the staff doors. Read before touching any session row or the Sessions UI. |
| 14 | [`09-failure-modes.md`](./09-failure-modes.md) | **The cross-service failure matrix**: Postgres (and `PG_POOL_MAX=1`), Upstash (outage and quota), Resend, Novu, the gateways, Stream, Sentry, Netlify (cold stall, timeout, env reclaim) and the auth layer itself. What the user sees, what the code does, what it should do, and who owns it. Read before an on-call rotation. |

> **Two `04-` files and two `09-` files.** The numbering predates this pass and the
> collisions are real; the filenames are load-bearing because other documents
> link to them. If you renumber, grep first.

Authorization (role hierarchy, capability gates, `requireOrgAccess`, and the
B2C entitlement ladder) lives in
[`docs/authorization/`](../../authorization/README.md).


## Companion docs (already in repo, don't duplicate)

- [`docs/enterprise/20-iam-and-security/01-sso-and-authentication.md`](../../enterprise/20-iam-and-security/01-sso-and-authentication.md) — enterprise admin's view of SSO config (allowedEmailDomains, enforceSSO, IdP recipes for Okta/Auth0).
- `docs/enterprise/playbooks/sso-testing.md` *(planned; not in repo yet)* — four ways to exercise the SAML/OIDC flow locally (mocksaml.com, saml-idp, Keycloak, real Auth0/Okta dev tenants).

This folder focuses on **the implementation**: what the code does, why
it does it that way, and the foot-guns. The enterprise docs above focus
on **how to configure** SSO for a tenant. Keep them in lock-step but
don't repeat content.

## TL;DR for the impatient

1. **No JWT.** Sessions are server-side rows in a Postgres `Session`
   table; the client carries an opaque cookie. We get revocation,
   audit, and rotation for free at the cost of a DB read per session
   validation (the cookie cache is off, so a revoke applies on the next
   request). See [`01-architecture.md`](./01-architecture.md).
2. **Middleware is cookie-only.** `middleware.ts` runs in the Edge
   Runtime, can't import BetterAuth's Node-only deps, and only checks
   for a session cookie. Real validation happens in the API route via
   `requireApiAuth()`. See [`02-middleware.md`](./02-middleware.md).
3. **Role hierarchy (org-side):** `OWNER > MAINTAINER > MANAGER > EXPERT > SUPPORT > LEARNER`. Platform-side: `ADMIN > STAFF > everyone-else`. Use the typed helpers in `lib/auth-helpers.ts`; never inline-compare roles. See [`docs/authorization/`](../../authorization/README.md).
4. **One membership table.** Org membership is the typed `Membership`
   (role/status/profile links). BetterAuth's organization plugin and its
   `Member` table are not used; SSO JIT writes `Membership` at sign-in
   (`lib/sso/jit-membership.ts`).
5. **SSO enforcement is server-side.** `session.create.before` rejects
   credential/OAuth signins from enforced domains at the source (closes
   #673). There is no read-time enforcement: a `ssoEnforcementFailed`
   flag existed in `customSession` but never had a consumer and was
   removed in #1242 — re-introduce it only WITH its consumer, per the
   spec in [#1241](https://github.com/Practitionist/familiarise_web/issues/1241).
   See [`sso/README.md`](./sso/README.md).
6. **Rate limits fail open.** If Redis is unreachable,
   `applyRateLimit()` returns `null` and the request proceeds. Better
   to ship a request during an Upstash outage than to 429 every login.
   The header `x-rate-limit-degraded` is the missing half: a consumer
   should *raise the price of a guess* when it is present, not lock the
   site down. See [`04-rate-limiting.md`](./04-rate-limiting.md) and
   [`09-failure-modes.md`](./09-failure-modes.md).
7. **The error vocabulary is closed.** `AUTH_ERROR_COPY` is a
   `Record<AuthErrorCode, AuthErrorCopy>`, so a new Better Auth code is a
   **compile error**, not a generic toast. And the client is never the
   authority on whether an address exists — the specific "no account
   matches that email" sentence unlocks only when the server says so, on
   a header. See [`04-errors.md`](./04-errors.md).


## Quick orientation by problem

> "I'm writing a new API route that needs auth."
>
> Use `requireApiAuth()`, `requireOrgAccess(orgId, "MAINTAINER")`, or
> `requireAdminAuth()` from `lib/auth-helpers.ts`. Never roll your own
> session check — they handle the 401/403/404/409 envelope correctly.
> See [`docs/authorization/`](../../authorization/README.md).

> "Should this endpoint be rate-limited?"
>
> If it's POST + abuseable (auth, sign-up, password-reset, invite-accept,
> SSO domain-check) yes. If it's a public read that hits Postgres
> (search, availability, eligibility) yes. Otherwise probably no.
> For an auth or enterprise surface, declare a row in `RATE_POLICIES`
> and a `POLICY_ROUTES` entry naming the scope — **not** a number in
> `middleware.ts`. For anything else, append a `RateRule`. See
> [`04-rate-limiting.md`](./04-rate-limiting.md).

> "This auth code doesn't compile and the error is about a `Record`."
>
> You added a member to `AuthErrorCode` and the catalog has no copy for
> it. That is the designed outcome. Add the entry to
> `AUTH_ERROR_COPY` — the union is closed on purpose so a Better Auth
> upgrade surfaces as a build failure rather than a generic toast. See
> [`04-errors.md`](./04-errors.md).

> "The customer says they get 'something went wrong on our side'."
>
> They should not — that sentence is now only reachable as a true last
> resort. Get the `code` off the response and the `scope` off the 429,
> and read [`04-errors.md`](./04-errors.md) and
> [`09-failure-modes.md`](./09-failure-modes.md) in that order. Row 1 of
> the failure matrix is Redis, and it is *silent* by design.

> "The app is broken and nothing in Sentry explains it."
>
> Check `09-failure-modes.md` first. The likeliest candidates are the
> `PG_POOL_MAX=1` pool, a Netlify cold-instance stall (a client `status
> 0`, not a 5xx), and a `trustedOrigins` gap on a deploy preview — all
> three produce a sentence that looks like the customer's fault and is
> not.

> "Why is my SSO test failing?"
>
> Run `scripts/verify-sso-invariants.sh` first — it catches eight
> common regressions statically (missing PKCE, re-added callbackUrl,
> orphan provider userId, etc.). If green, see
> `docs/enterprise/playbooks/sso-testing.md`.

> "How do I add a new BetterAuth plugin?"
>
> Plugins go in `lib/auth.ts`'s `plugins: [...]` array. `nextCookies()`
> must stay last. Anything that touches the session shape needs a
> matching client-side mirror in `lib/auth-client.ts`. See
> [`01-architecture.md`](./01-architecture.md).

> "Why doesn't middleware redirect me to the dashboard if I'm logged in?"
>
> Cookie presence ≠ session validity. Stale cookies (DB session GC'd)
> would cause an infinite loop: middleware → /dashboard →
> requireOnboarded → /auth/signin → /dashboard. The signin page itself
> uses `useSession()` to redirect authenticated users client-side. See
> the comment at `middleware.ts:286-289`.

If something in the code disagrees with these docs, the code is the
source of truth — file an issue and the docs get patched.
