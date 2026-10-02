---
title: The auth schema is frozen at launch; later changes are additive only
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-10-01
---

# ADR 36 — Auth schema freeze

## Context

The auth tables were about to be written to by real users, and two things
make changing them later expensive. Tightening a column (nullable to NOT
NULL, `timestamp` to `timestamptz`, a string to an enum) rewrites the table
under traffic. BetterAuth 1.7 also checks the generated Prisma client on
the first auth request and fails every `/api/auth/*` call if a table or
column it writes is missing. Before launch the database is disposable, so
this was the cheap moment to make the schema right (#705, PR #1878).

## Decision

Freeze the auth schema at the pre-MVP reset in this shape:

| Model                     | Frozen shape                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`                    | `role`, `emailVerified`, `banned`, `twoFactorEnabled` NOT NULL with defaults; `createdAt`/`updatedAt` `timestamptz`. No `lower(email)` index: BetterAuth lowercases emails before every write and lookup. |
| `Session`                 | BetterAuth core + `impersonatedBy`; `@@index([userId, createdAt])` (device list) and `@@index([expiresAt])` (sweep); `timestamptz`.                                                                       |
| `Account`                 | Unchanged columns, unique `(providerId, accountId)`; `timestamptz`.                                                                                                                                       |
| `Verification`            | `@@index([expiresAt])`; identifiers stored hashed (`verification.storeIdentifier: "hashed"`); `timestamptz`.                                                                                              |
| `TwoFactor`               | `userId @unique`; `verified` (default true) and `failedVerificationCount` (default 0) NOT NULL; `lockedUntil` `timestamptz`.                                                                              |
| `SsoProvider`             | Real FK to `Organization` (cascade), `userId` set-null, `domainVerified` (staff approval), `createdAt`/`updatedAt`; `samlConfig` kept nullable for later.                                                 |
| `OrganizationSSOSettings` | `enforceSSO`, `defaultRoleForAutoJoin`, `version`. No domain list: verified `OrgDomainClaim` rows are the only domain truth.                                                                              |
| `Invitation`              | `role` is `MemberRole`, `status` is `InvitationStatus`.                                                                                                                                                   |

Two guards keep it that way:

- `scripts/ci/check-auth-schema.ts` (CI "Auth schema guard") runs
  BetterAuth's own `getExpectedSchema` + `diffSchema` for the app's real
  options against the Prisma DMMF, plus a field-type check.
- `prisma/sql/check-constraints.sql` ends with a `REVOKE ALL` on `public`
  from Supabase's `anon` and `authenticated` roles, including default
  privileges. The app only connects as the owner through Prisma, and the
  anon key is public, so without it the Data API could read sessions and
  accounts. It is a no-op where those roles do not exist.

After launch, changes are additive only: new nullable or defaulted columns,
new tables (passkeys, `jitEnabled`) and new indexes. Renames, drops, type
changes and new NOT NULL columns without a default need their own ADR and a
migration plan.

## Alternatives considered

- **Additive-only now, tighten later.** Every deferred item becomes a table
  rewrite on live data.
- **Row-level security policies instead of `REVOKE`.** Nothing reads these
  tables through PostgREST, so policies would be machinery with no caller.
- **Diffing against `npx auth generate` output.** That needs the CLI and a
  formatter-stable Prisma file; reusing the runtime's own comparison is the
  same rule with no text diff.

## Consequences

The reset `db push` rewrites the auth tables (type changes, new FKs and
enums) and must run on an empty or disposable database. BetterAuth upgrades
that add columns now fail CI rather than production. The decisions behind
this shape (D1–D28 of the #1878 review) are summarized below.

| Decision              | Outcome                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1–D2                 | BetterAuth 1.7.6; keep the two PRs                                                                                                            |
| D3–D6, D24            | DB-only sessions, no cap, no device columns, 30-day sliding; operators capped at 12h ([ADR 35](35-user-session-visibility-and-revocation.md)) |
| D7, D25               | Mandatory TOTP for staff/admin only; operators use credential sign-in                                                                         |
| D8, D23, D26          | Staff created with `createUser` + reset link; ADMIN suspend/reactivate and resend                                                             |
| D9                    | Impersonation off; `Session.impersonatedBy` kept                                                                                              |
| D10–D11, D20–D22, D28 | OIDC-only SSO, staff-approved providers, no org plugin ([ADR 06](06-typed-membership-over-betterauth-member.md)), one domain truth            |
| D12–D14, D27          | BetterAuth rate limiter on Upstash, generic errors, no captcha, own HIBP check                                                                |
| D15–D16               | Google and GitHub only; CSP report-only at launch                                                                                             |
| D17–D19               | This freeze, one `REVOKE` sidecar, invitation enums                                                                                           |
