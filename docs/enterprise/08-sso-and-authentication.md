# SSO and authentication

SSO for the enterprise layer is a two-table split:

- `OrganizationSSOSettings` — policy columns we own (allowed domains,
  enforcement, auto-join role).
- `SsoProvider` — BetterAuth-owned SAML/OIDC config (issuer, entity,
  cert, redirect). Our schema carries a back-reference via
  `organizationId`.

A third table, `OrgDomainClaim`, asserts domain ownership at the
platform scope so two different orgs can't both enforce SSO for the
same email domain.

## `OrganizationSSOSettings`

```prisma
model OrganizationSSOSettings {
  id             String @id @default(uuid())
  organizationId String @unique
  allowedEmailDomains    String[]   @default([])
  enforceSSO             Boolean    @default(false)
  defaultRoleForAutoJoin MemberRole @default(LEARNER)
  ...
}
```

- `allowedEmailDomains` — the domain allowlist for auto-join on first
  SSO sign-in (e.g. `["acme.com", "acme.co.in"]`). Not case-sensitive;
  normalised to lower-case at write time.
- `enforceSSO` — when `true`, accounts whose email matches one of the
  allowed domains must authenticate via SSO. Password/OAuth sign-ins
  are allowed for auditing (the session is flagged) but the
  `customSession` hook marks them `ssoEnforcementFailed = true`, which
  the dashboard uses to block entry.
- `defaultRoleForAutoJoin` — the `MemberRole` assigned when an SSO
  user lands in the org for the first time. Default `LEARNER`.

Managed via `GET /api/organizations/[orgId]/sso` (MANAGER) and
`PATCH /api/organizations/[orgId]/sso` (OWNER).

## `SsoProvider`

```prisma
model SsoProvider {
  id             String  @id
  issuer         String
  oidcConfig     String?
  samlConfig     String?
  userId         String?
  providerId     String
  organizationId String?
  domain         String
  ...
}
```

Created via `POST /api/organizations/[orgId]/sso/providers` (OWNER),
listed via `GET` (MANAGER), deleted via `DELETE` (OWNER). The
BetterAuth plugin handles the SAML/OIDC handshake; this table is
consulted by our `customSession` hook (`lib/auth.ts`) to decide whether
the account that just logged in satisfies the enforcing org's policy.

## `OrgDomainClaim`

```prisma
model OrgDomainClaim {
  id             String @id @default(uuid())
  domain         String @unique
  organizationId String
  claimedAt      DateTime @default(now())
  ...
}
```

`domain` is globally unique. Two orgs cannot both claim `acme.com` —
the second POST returns a Prisma P2002 error which the
`/api/organizations/[orgId]/domain-claims` handler maps to a 409.

Claims are managed by OWNER:

- `POST /api/organizations/[orgId]/domain-claims` — adds a claim for
  the current org.
- `DELETE /api/organizations/[orgId]/domain-claims/[domain]` — releases
  a claim.

A domain claim is a stronger signal than `allowedEmailDomains`: it
asserts that the org is the *exclusive* rightful home for any user
with that email domain, which is what drives the login-time redirect
UX and enforces single-tenancy for HRIS auto-sync.

## Anti-lockout guards

SSO is a compliance-sensitive feature; we make it very hard to lock
yourself out:

1. **Enforcement only applies to SSO users.** The `customSession` hook
   checks for an `Account` row with `providerId` matching one of the
   registered `SsoProvider.providerId` values. It fails *closed* —
   i.e. it only flags a session as non-SSO when SSO is actually
   configured. An org that has `enforceSSO = true` but zero registered
   providers never locks anyone out (the `customSession` code has an
   explicit "no registered providers" early return in `lib/auth.ts`).
2. **Platform admins always get in.** `requireOrgAccess` bypasses
   membership checks for `UserRole.ADMIN` and returns a synthesized
   OWNER membership — a lock-out can always be resolved by a platform
   admin from the admin console.
3. **Owners can disable enforcement from anywhere.** The PATCH handler
   at `/api/organizations/[orgId]/sso` does not itself require SSO.
4. **Domain claim release is DELETE-by-owner.** Not
   DELETE-by-anyone-with-matching-email.

## Auto-join flow

When an SSO user lands for the first time:

1. BetterAuth creates the platform `User` + `Account` (with
   `providerId = ssoProvider.providerId`).
2. BetterAuth's organization plugin sees a matching org (via allowed
   domain) and creates a bare `Member` row.
3. `customSession` (`lib/auth.ts`) spots the bare `Member` without a
   `Membership` sibling and auto-creates one:
   - `role = defaultRoleForAutoJoin` — **locked to `LEARNER`** (audit
     Phase A.1; see [#jit-default-role](#jit-default-role) below).
   - `status = ACTIVE`
   - `consulteeProfileId` is populated when the role is LEARNER and
     the user has an existing ConsulteeProfile.
4. The `Member.id` is recorded as `Membership.betterAuthMemberId` so
   the bridge between the two tables is live.

The auto-repair is wrapped in a try/catch that swallows Prisma P2002
(unique-constraint races) ONLY — every other error re-throws and
surfaces at the BetterAuth boundary. Audit Phase A.3 narrowed the
prior bare `catch {}` because it swallowed transient DB drops + RLS
denials, leaving users with a session cookie but no Membership row.

For the full sequence (including the `sessionGeneration` marker that
keeps active sessions fresh after role changes) see
[`28-jit-and-session-refresh.md`](./28-jit-and-session-refresh.md).

### JIT default role

`OrganizationSSOSettings.defaultRoleForAutoJoin` is locked at
`LEARNER` — the schema is `z.literal("LEARNER")` in
`lib/labels/org-labels.ts:JitDefaultRoleSchema`. The PATCH handler at
`/api/organizations/[orgId]/sso` rejects any other value with 400
`INVALID_DEFAULT_ROLE`.

Pre-audit, this field accepted any role including `OWNER`. With SSO
enabled, the first user to sign in via the IdP became co-owner of the
org instantly — a catastrophic privilege grant if the IdP was ever
misconfigured (or if anyone in the IT department happened to be on
that domain). The fix is principle-of-least-privilege: everyone lands
as LEARNER, admins promote explicitly via `/dashboard/.../members`,
the promotion is audit-logged (`MEMBER_ROLE_CHANGED`).

### Cert rotation

Cert rotation is **delete-then-recreate**, NOT PATCH. We deliberately
don't ship a `PATCH /sso/providers/[providerId]` endpoint because
silent config drift between the dashboard's cached state and the
actual IdP is a recurring source of broken SAML handshakes.

When your cert is approaching expiry:
1. Export the new PEM block from your IdP's admin console.
2. In Familiarise, DELETE the existing provider.
3. POST a fresh provider with the same `providerId` + new `cert`.

The cron at `scripts/sso-cert-expiry-alert.ts` warns 30 days before
expiry so this fire-drill is never a surprise.

### Cert format validation

POST validates the `samlConfig.cert` field via Node's
`crypto.X509Certificate` constructor before any DB write. A malformed
PEM (e.g. pasting the base64 fingerprint by mistake, or pasting only
the body without `-----BEGIN/END CERTIFICATE-----` markers) returns
400 with a friendly error pointing at where to find the correct PEM
in the IdP console.

Pre-audit, the schema was `z.string().min(1)`. Garbage strings passed
the schema check and crashed BetterAuth's underlying SAML adapter
(`@node-saml/node-saml`) at first signin with
`TypeError: Cannot read properties of undefined (reading 'metadata')`.
The 500 had an empty body, and the UI gave no feedback. Audit Phase A.2.

### IdP-issued email verification

The SAML assertion / OIDC token's `email` claim is trusted as the
user's verified identity. We do NOT re-check email ownership in
Familiarise — the IdP is the authority.

**This means your IdP MUST be configured to:**
- Only release email claims for verified mailbox owners.
- Reject sign-ins from accounts whose email is unverified.
- For Okta: see "Profile → Profile editor → email → required + verified".
- For Azure AD: see "Enterprise apps → Familiarise → SSO → Edit attributes & claims".
- For Google Workspace: enforced by default — all `@your-domain.com`
  emails are verified Workspace addresses.

If your IdP releases an unverified email (e.g. an Azure AD guest
account whose email was never proven), an attacker could impersonate
that email. Familiarise's domain-ownership gate
(`OrgDomainClaim.verifiedAt`) prevents cross-org email spoofing, but
within-org spoofing depends on IdP hygiene.

## Session enforcement

The `customSession` hook at the end of `lib/auth.ts` runs on every
request and:

- Hydrates `organizationMemberships[]` into the session shape (see
  `00-overview.md` for the exact field list).
- Computes `ssoEnforcementFailed` per the checks above.
- Silently drops any enforcement check if the user's email domain
  doesn't match any enforcing org (failing open, not closed, so a
  non-corporate sign-in isn't blocked by an unrelated tenant's policy).

The hook also runs `shouldRejectSession` (`lib/sso/enforce-session.ts`)
at the `session` hook level — this is the defence-in-depth check that
runs at `sign-in` time rather than at session-read time.

## Related docs

- [`28-jit-and-session-refresh.md`](./28-jit-and-session-refresh.md) —
  JIT auto-join sequence, `sessionGeneration` marker, role-change
  refresh without forced logout.
- [`30-rate-limiting.md`](./30-rate-limiting.md) — why BetterAuth's
  built-in limiter is disabled and where the Upstash-backed limiters
  cover auth + SSO endpoints.
- [`reference/sso-error-codes.md`](./reference/sso-error-codes.md) —
  every typed HTTP error code emitted by the SSO routes.
- `playbooks/sso-testing.md` — four local-test recipes against mock and
  real IdPs.
- `04-roles-and-permissions.md` — `MemberRole` rank ladder.
- `12-dashboard-pages.md` — the `/settings/sso` page that drives these
  APIs.
