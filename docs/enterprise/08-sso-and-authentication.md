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
   - `role = defaultRoleForAutoJoin`
   - `status = ACTIVE`
   - `consulteeProfileId` is populated when the role is LEARNER and
     the user has an existing ConsulteeProfile.
4. The `Member.id` is recorded as `Membership.betterAuthMemberId` so
   the bridge between the two tables is live.

The auto-repair is wrapped in a try/catch that swallows Prisma P2002
(unique-constraint races) — two concurrent sessions creating the same
Membership is safe and idempotent.

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

- `sso-testing-guide.md` — four local-test recipes against mock and
  real IdPs.
- `04-roles-and-permissions.md` — `defaultRoleForAutoJoin` options.
- `12-dashboard-pages.md` — the `/settings/sso` page that drives these
  APIs.
