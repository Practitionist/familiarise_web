# Authentication

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Sibling folder | [`docs/authorization/`](../authorization/) for "what can this user do" |

## 1. Background

This folder documents the **authentication** subsystem — every code
path that answers "who is this user?". Authorization (what they can
*do* once we know who they are) lives in the sibling folder above.

The subsystem is built on [BetterAuth](https://better-auth.com), a
TypeScript-first auth library. We use it because:

- It's framework-agnostic (Next.js Edge / Node, plain Express, etc).
- The plugin model lets us add SSO, organizations, and custom session
  shape without forking the library.
- Sessions are server-side rows we own (Postgres `Session` table) —
  no JWT envelope, no signing-key rotation, no opaque-token refresh
  dance. Revocation is `DELETE FROM Session WHERE …`.

## 2. Scope

| In scope | Out of scope |
|---|---|
| BetterAuth setup + plugin chain | What roles can do — see [`authorization/`](../authorization/) |
| Session model + lifecycle | Profile editing UX |
| The error catalog, and what a customer is told | Payment / KYC identity (separate concern) |
| OAuth providers (when active) | Enterprise SSO configuration (the admin's view) |
| Enterprise SSO (SAML + OIDC) | Mobile push-token auth (not in scope yet) |
| Middleware request lifecycle | API routing for non-auth surfaces |
| Auth-related rate limiting | Per-feature rate limits — handler-side |
| Cross-service failure modes | |

## 3. Where to start

Read the children in this order:

| # | Path | Reading time |
|---|---|---|
| 1 | [`betterauth/README.md`](./betterauth/README.md) | 5 min |
| 2 | [`betterauth/01-architecture.md`](./betterauth/01-architecture.md) | 15 min |
| 3 | [`betterauth/02-middleware.md`](./betterauth/02-middleware.md) | 10 min |
| 4 | [`betterauth/03-sessions-and-hooks.md`](./betterauth/03-sessions-and-hooks.md) | 10 min |
| 5 | [`betterauth/04-errors.md`](./betterauth/04-errors.md) | 15 min |
| 6 | [`betterauth/04-rate-limiting.md`](./betterauth/04-rate-limiting.md) | 10 min |
| 7 | [`betterauth/sso/README.md`](./betterauth/sso/README.md) | 15 min |
| 8 | [`betterauth/oauth/README.md`](./betterauth/oauth/README.md) | 5 min |
| 9 | [`betterauth/05-testing.md`](./betterauth/05-testing.md) | 10 min |
| 10 | [`betterauth/06-ci-deployment.md`](./betterauth/06-ci-deployment.md) | 10 min |
| 11 | [`betterauth/08-staff-onboarding.md`](./betterauth/08-staff-onboarding.md) | 10 min |
| 12 | [`betterauth/09-failure-modes.md`](./betterauth/09-failure-modes.md) | 20 min |

Total: ~2h20 for full onboarding. The first four are mandatory before
touching any auth code. `09-failure-modes.md` is the one to read before
an on-call rotation.

## 4. What changed, and why

The productionisation pass in this branch changed the shape of the
subsystem in four places, and each change exists to remove a specific
failure rather than to be tidy.

**A closed error vocabulary.** `AuthErrorCode` is a closed union and
[`lib/labels/auth-errors.catalog.ts`](../../lib/labels/auth-errors.catalog.ts)
is a `Record<AuthErrorCode, AuthErrorCopy>`. A Better Auth minor that adds
an error code is now a **build failure** instead of a customer staring at
"Something went wrong on our side" — and that sentence, produced by a
`Record<string, …>`, was what made every unhandled code a support ticket
nobody could diagnose. Read
[`betterauth/04-errors.md`](./betterauth/04-errors.md).

**Graded disclosure, gated on the server.** `INVALID_EMAIL_OR_PASSWORD`
means wrong password, no such account and no-password account all at
once. The specific sentence unlocks only after three recorded failures
for that address, and only on a flag the server publishes on a response
header. The lockout that makes disclosure affordable is in
[`lib/auth/attempts.ts`](../../lib/auth/attempts.ts): 3 failures unlock
the sentence, 8 lock the account for 15 minutes then an hour. A Redis
failure fails **open** for the lockout and **closed** for disclosure —
the two directions are opposite on purpose.

**Rate limits as one declaration.** `middleware.ts` used to name
`/api/auth/forget-password`, a route BetterAuth has never had, so the
prefix matched nothing and the entire forgot-password flow — the
endpoint that mails unlimited reset links — ran unthrottled for the life
of the app. `lib/rate-limit/policies.ts` now declares scope, window,
budgets and rationale in one row; `middleware.ts` can name a scope but no
longer a number, and a policy declared but never matched logs at boot.
Read [`betterauth/04-rate-limiting.md`](./betterauth/04-rate-limiting.md).

**Cross-service failure modes, in one matrix.** Postgres pool
exhaustion, an Upstash outage, a Resend outage, a Netlify cold-instance
stall and a `trustedOrigins` misconfiguration all used to produce the
same sentence, and each has a different correct one. Read
[`betterauth/09-failure-modes.md`](./betterauth/09-failure-modes.md) — it
also carries the open backlog, of which the highest-leverage item is that
nothing calls `markExpected` on the auth errors that are refusals rather
than faults.

Alongside those: per-account lockout and captcha, the SAML
`spMetadata` fix that made every SAML provider in the database able to
fail sign-in, AES-256-GCM at rest for customer IdP secrets, and
registration-time OIDC discovery so a bad IdP is rejected while the admin
is still looking at the form.

## 5. Companion docs

- [`docs/authorization/01-authorization-matrices.md`](../authorization/01-authorization-matrices.md)
  — the four authorization matrices, and why they are not merged. The
  sibling question, in one place.
- [`docs/enterprise/20-iam-and-security/01-sso-and-authentication.md`](../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — enterprise admin's view of SSO config (allowedEmailDomains,
  IdP recipes for Okta/Auth0). Configuration-side; this folder is
  implementation-side. Keep them in lock-step but don't duplicate.
- `docs/enterprise/playbooks/sso-testing.md` *(planned; not in repo yet)*
  — four ways to exercise SSO locally
  (mocksaml.com / saml-idp / Keycloak / real dev tenants). Read after
  this folder if you need to test.

## 6. Related docs

- [`docs/authorization/`](../authorization/) — the sibling folder for
  authz helpers (`requireApiAuth`, `requireOrgAccess`, role matrices).
- [`docs/errors/01-refusals.md`](../errors/01-refusals.md) — the
  `Refusal` rail for business outcomes, which is a different thing from
  an auth error and deliberately so.
- [`docs/api/`](../api/) — general API conventions.
- [`docs/infrastructure/`](../infrastructure/) — Redis, Docker,
  deployment topology that auth depends on.
- [`docs/upstash/00-pricing-overview.md`](../upstash/00-pricing-overview.md)
  — the command ceiling the rate limiter runs into.

