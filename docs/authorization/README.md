# Authorization

| Field         | Value                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| Status        | Stable                                                                  |
| Audience      | All engineers                                                           |
| Last reviewed | 2026-10-01                                                              |
| Source files  | `lib/auth-helpers.ts`, `lib/auth-guard.ts`, `lib/auth/*-permissions.ts` |

This folder answers **what a signed-in user may do**. Who the user is (sessions,
sign-in, 2FA, SSO) is in [`../authentication/`](../authentication/README.md).

## 1. Three matrices

| Axis         | Key               | Source of truth                                                                                              |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Platform     | `User.role`       | `UserRole` enum: `CONSULTEE`, `CONSULTANT`, `STAFF`, `ADMIN`, `ORG_WORKSPACE`                                |
| Organisation | `Membership.role` | `ORG_PERMISSIONS` in [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts)                      |
| Back office  | `User.role`       | `BACKOFFICE_PERMISSIONS` in [`lib/auth/backoffice-permissions.ts`](../../lib/auth/backoffice-permissions.ts) |

Only `ADMIN` and `STAFF` are privileged (`isPrivileged()`). `ORG_ROLE_RANK` in
`lib/auth/role-ranks.ts` is display order only and never an authorization input.
Why there are three and why they stay separate:
[`01-authorization-matrices.md`](./01-authorization-matrices.md).

## 2. API route helpers (`lib/auth-helpers.ts`)

Every helper returns `{ session }` or `{ error: NextResponse }`; return the
error as is.

| Helper                              | Admits                                              | Refusal                          |
| ----------------------------------- | --------------------------------------------------- | -------------------------------- |
| `requireApiAuth()`                  | Any live, unbanned session; operators need 2FA      | 401, 403 suspended, 428, 503     |
| `requireApiSession()`               | As above without the 2FA gate (session probe only)  | 401, 403, 503                    |
| `requireAdminAuth()`                | `ADMIN`                                             | 403                              |
| `requireStaffAuth()`                | `STAFF` only (rejects `ADMIN`)                      | 403                              |
| `requirePrivilegedAuth()`           | `ADMIN` or `STAFF`                                  | 403                              |
| `requireBackofficeSurface(surface)` | Roles granted `surface` in `BACKOFFICE_PERMISSIONS` | 403                              |
| `requireOrgAccess(orgId, opts)`     | Active member holding `opts.permission`             | 403, 404, 409 (see §3)           |
| `authorizeEventAccess(...)`         | Event consultant, consultee, collaborator, operator | returns a 403 response or `null` |
| `checkOwnership(...)`               | Boolean profile-id match                            | caller decides                   |

All role helpers call `requireApiAuth()` first, so they inherit its 401/428/503.
Prefer `requireBackofficeSurface` over the coarse role helpers on any back-office
route: pick the surface, not the role. `forbiddenResponse()` and
`unauthorizedResponse()` build plain 403/401 bodies. The decision matrix for
operator routes is in [`../api/auth-helpers.md`](../api/auth-helpers.md).

### Operator 2FA gate

A `STAFF`/`ADMIN` session without enrolled TOTP gets **428**
`TWO_FACTOR_REQUIRED` with header `X-Auth-Action: enroll-2fa`. `twoFactorEnabled`
is rebuilt from the user row on every read (no cookie cache), so it is as fresh
as a column read. Enrolment runs on BetterAuth's `/two-factor/*` endpoints, which
never reach this helper.

## 3. `requireOrgAccess(orgId, opts)`

```ts
requireOrgAccess(orgId, {
  permission?: OrgSurface | readonly OrgSurface[], // any-of; omitted = any ACTIVE member
  canSponsor?: true,
  canHost?: true,
  fundingSource?: FundingSource,
  requireActive?: true,
  allowSuspended?: true, // refused when combined with `permission`
});
```

Order of checks and their answers:

| Check                                             | Status          | Body                                         |
| ------------------------------------------------- | --------------- | -------------------------------------------- |
| `requireApiAuth()`                                | 401/403/428/503 | as above                                     |
| Org missing                                       | 404             | `Organization not found`                     |
| Org `DEACTIVATED`                                 | 403             | `Organization has been deactivated`          |
| `requireActive` and org not `ACTIVE`              | 409             | `error: "ORG_NOT_VERIFIED"`                  |
| `canSponsor` / `canHost` / `fundingSource` miss   | 404             | the endpoint does not exist for this org     |
| Not a member                                      | 403             | `Not a member of this organization`          |
| Membership not `ACTIVE` (unless `allowSuspended`) | 403             | `Membership is <status>`                     |
| Role lacks `permission`                           | 403             | `Forbidden — your role does not grant <key>` |

Capability gates answer **404**, not 403: a host-only org has no sponsor API, so
"not found" is the honest answer. A platform `ADMIN` skips the membership and
permission checks and gets a synthesized `OWNER` membership, but the capability
gates still apply. There is no rank comparator and no owner-only wrapper; an
owner-only route names an OWNER-only key. A jest pin
(`__tests__/enterprise/org-route-matrix-pin.test.ts`) fails any org route with
no matrix key or a rank check.

## 4. Page guards (`lib/auth-guard.ts`)

Page guards redirect instead of returning a status.

| Guard                                  | Redirects to                                            |
| -------------------------------------- | ------------------------------------------------------- |
| `requireAuth()` / `requireOnboarded()` | sign-in (no session or banned) / `/form/onboarding`     |
| `requireUserRole(roles)`               | `/dashboard`                                            |
| `requireOperator()`                    | `/auth/two-factor/setup` when 2FA is not enrolled       |
| `requireOperatorAwaitingTwoFactor()`   | `/dashboard` once enrolled (the setup page's own guard) |
| `requireBackofficePage(surface, tree)` | `/dashboard`, or the tree's own landing                 |

A session lookup that did not complete throws to the error boundary (retry)
instead of redirecting. Every `(backoffice)/[tree]` page calls `requireBackofficePage`: layouts do not
re-run on client navigation, and a hidden sidebar link is not access control.
Redirect rules after sign-in are in
[`../authentication/redirects-and-navigation.md`](../authentication/redirects-and-navigation.md).

## 5. Status conventions

| Status | Meaning                                                                   |
| ------ | ------------------------------------------------------------------------- |
| 401    | No session, expired, or not found                                         |
| 403    | Signed in but not allowed (role, membership, suspended account)           |
| 404    | Resource or capability does not exist for this org shape                  |
| 409    | `ORG_NOT_VERIFIED`: allowed later, once a platform admin verifies the org |
| 428    | Operator must enrol 2FA first                                             |
| 503    | Session lookup or schema read did not complete; retry after `Retry-After` |

A 503 is never "signed out": the client retries instead of clearing the session.
Auth error codes and their client handling:
[`../authentication/errors.md`](../authentication/errors.md).

## 6. Related

- [`../authentication/architecture.md`](../authentication/architecture.md) —
  session read path and the guards that sit on it.
- [`../authentication/staff-onboarding.md`](../authentication/staff-onboarding.md)
  — adding, suspending and resetting operators (`users.moderate`).
- [`../enterprise/00-foundations/04-roles-and-permissions.md`](../enterprise/00-foundations/04-roles-and-permissions.md)
  — what each org role sees.
