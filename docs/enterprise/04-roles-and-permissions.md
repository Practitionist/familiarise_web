# Roles and Permissions

**Status**: Implemented (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: `OrgMemberRole` enum, API authorization, dashboard visibility

## Overview

Every organization member has exactly one role, stored as the `OrgMemberRole` enum on `OrganizationMemberProfile.role`. Roles are ranked numerically (20-100) so that authorization checks reduce to a single comparison: "does the caller's rank meet the minimum required rank?" The ranking is defined in `ORG_ROLE_RANK` in `lib/auth-helpers.ts` and mirrored in the dashboard layout for nav visibility. Platform admins (UserRole `ADMIN`) bypass org membership checks entirely -- they receive a synthesized `ORG_OWNER` stub.

---

## Role Reference

| Role | Rank | Available In | Purpose | Feature-Flagged |
|------|------|-------------|---------|-----------------|
| `ORG_OWNER` | 100 | BUYER, PROVIDER, HYBRID | Full control: billing, deletion, settings, members | No |
| `ORG_ADMIN` | 80 | BUYER, PROVIDER, HYBRID | Members + plans + settings (no billing or org deletion) | No |
| `ORG_MANAGER` | 60 | BUYER, PROVIDER, HYBRID | BUYER: team analytics + seat management. PROVIDER: consultant earnings view | No |
| `ORG_CONSULTANT` | 40 | PROVIDER, HYBRID only | Provides services on behalf of the org; earnings split 3 ways | Yes (`ENABLE_PROVIDER_ORGS`) |
| `ORG_SUPPORT` | 30 | BUYER, PROVIDER, HYBRID | Support staff with no billing access | Yes (for PROVIDER) |
| `ORG_LEARNER` | 20 | BUYER, HYBRID only | Employee or student consuming sessions | No |

---

## Role Hierarchy

```
         ┌──────────────┐
         │  ORG_OWNER   │  rank 100
         │  Full control │
         └──────┬───────┘
                │
         ┌──────▼───────┐
         │  ORG_ADMIN   │  rank 80
         │  Members +   │
         │  settings    │
         └──────┬───────┘
                │
         ┌──────▼───────┐
         │  ORG_MANAGER │  rank 60
         │  Analytics + │
         │  seat mgmt   │
         └──────┬───────┘
                │
         ┌──────▼────────┐
         │ ORG_CONSULTANT│  rank 40  (PROVIDER/HYBRID only)
         │ Provides      │
         │ services      │
         └──────┬────────┘
                │
         ┌──────▼───────┐
         │  ORG_SUPPORT │  rank 30
         │  Support     │
         │  staff       │
         └──────┬───────┘
                │
         ┌──────▼───────┐
         │  ORG_LEARNER │  rank 20
         │  Consumes    │
         │  sessions    │
         └──────────────┘
```

**How it works**: A role satisfies a minimum-role check if its rank is >= the required rank. ORG_OWNER (100) satisfies every check. ORG_LEARNER (20) only satisfies checks requiring ORG_LEARNER itself.

**File**: `lib/auth-helpers.ts` (line 278)

```
const ORG_ROLE_RANK: Record<OrgMemberRole, number> = {
  ORG_OWNER: 100,
  ORG_ADMIN: 80,
  ORG_MANAGER: 60,
  ORG_CONSULTANT: 40,
  ORG_SUPPORT: 30,
  ORG_LEARNER: 20,
};
```

---

## API Authorization

### requireOrgAccess(orgId, minimumRole?)

**File**: `lib/auth-helpers.ts` (line 331)

The primary guard for all org API routes. Called at the start of every route handler that operates on org data.

**What it does**:
1. Authenticates the session via `requireApiAuth()`
2. Resolves `OrganizationProfile` by the BetterAuth `Organization.id`
3. Rejects if org `status === "DEACTIVATED"` (403)
4. Platform admins (UserRole `ADMIN`) bypass membership lookup -- get a synthesized `ORG_OWNER` stub
5. Looks up `OrganizationMemberProfile` by joining through BetterAuth's `Member` table
6. Rejects if member not found (403: "Not a member of this organization")
7. Rejects if member `status !== "ACTIVE"` (403: "Membership is suspended/removed/pending")
8. If `minimumRole` is specified, checks `orgRoleSatisfies(member.role, minimumRole)`

**Returns on success**: `{ session, member, org }` where `member` is the `OrganizationMemberProfile` and `org` is the `OrganizationProfile`.

**Returns on failure**: `{ error: NextResponse }` with 401, 403, or 404.

**Usage in route handlers**:
```
const access = await requireOrgAccess(orgId, "ORG_ADMIN");
if (access.error) return access.error;
// access.session, access.member, access.org are all available
```

### requireOrgOwner(orgId)

Convenience wrapper: calls `requireOrgAccess(orgId, "ORG_OWNER")`. Used for billing changes, payout account setup, org deletion, and settings mutation.

### orgRoleSatisfies(actual, minimum)

Pure comparison function. Returns `true` if `ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum]`.

Examples:
- `orgRoleSatisfies("ORG_OWNER", "ORG_ADMIN")` -- true (100 >= 80)
- `orgRoleSatisfies("ORG_LEARNER", "ORG_MANAGER")` -- false (20 < 60)
- `orgRoleSatisfies("ORG_ADMIN", "ORG_ADMIN")` -- true (80 >= 80)

---

## Platform Admin Bypass

Platform-level `ADMIN` users (the Familiarise team) can access any organization without being a member. When `requireOrgAccess` detects `session.user.role === "ADMIN"`, it skips the membership lookup and returns a synthesized member stub:

```
{
  id: "__admin_stub_<userId>",
  role: "ORG_OWNER",       // highest rank — passes all minimumRole checks
  status: "ACTIVE",
  earningsRecipient: "CONSULTANT",
  ...                      // all nullable fields set to null
}
```

**Why**: Platform admins need to manage any org for support/operability without being invited as a member. The synthesized stub means callers don't need to special-case admin paths -- they just use `access.member.role` normally.

**STAFF do NOT bypass**: `STAFF` users are platform-side operators, not org-side. They must be explicitly added as org members to access org data.

---

## Dashboard Visibility

**File**: `app/dashboard/organization/[orgId]/layout.tsx` (line 99)

The sidebar computes which nav items to show based on both `org.profile.kind` and `membership.role`. The layout mirrors `ORG_ROLE_RANK` locally for the `isAtLeast()` check.

| Page | Path | Minimum Role | Kind Required |
|------|------|-------------|---------------|
| Overview | `home` | Any member | Any |
| Members | `members` | Any member | Any |
| Invitations | `invitations` | `ORG_ADMIN` (rank 80) | Any |
| Learners | `learners` | Any member | BUYER or HYBRID |
| Consultants | `consultants` | Any member | PROVIDER or HYBRID |
| Plans | `plans` | Any member | Any |
| Credits | `credits` | `ORG_MANAGER` (rank 60) | BUYER or HYBRID + SEAT_PACK billing mode |
| Billing | `billing` | `ORG_MANAGER` (rank 60) | Any |
| Payouts | `payouts` | Any member | PROVIDER or HYBRID |
| Analytics | `analytics` | `ORG_MANAGER` (rank 60) | Any |
| Settings | `settings` | `ORG_ADMIN` (rank 80) | Any |

**Important**: Dashboard nav visibility is cosmetic. The API layer enforces permissions independently via `requireOrgAccess` with the appropriate minimum role. Hiding nav items prevents confusion but is not the security boundary.

---

## Feature-Flagged Roles

Two roles are gated by `ENABLE_PROVIDER_ORGS`:

**ORG_CONSULTANT** (rank 40):
- Only available in PROVIDER and HYBRID orgs
- When the flag is `false`: POST `/api/organizations/[id]/members` rejects `role === "ORG_CONSULTANT"` with 501
- Dashboard hides the Consultants nav item (because `isProviderOrHybrid` is false for BUYER orgs, and PROVIDER/HYBRID creation is blocked)
- Consultants apply via `/api/organizations/[orgId]/consultants/apply` and are approved by ORG_ADMIN+

**ORG_SUPPORT** (rank 30):
- Available in all org kinds, but for PROVIDER orgs the support workflows (consultant dispute resolution, payout queries) only function when the flag is on
- When the flag is off in a BUYER org, ORG_SUPPORT still works for basic support tasks (member queries, session issues)

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Single role per org | A user can only have one `OrganizationMemberProfile` per org. No dual membership (e.g., cannot be both ORG_LEARNER and ORG_CONSULTANT in the same org). |
| Multi-org membership | A user CAN be ORG_CONSULTANT in Org A and ORG_LEARNER in Org B. Each org has its own `OrganizationMemberProfile`. |
| Org is DEACTIVATED | `requireOrgAccess` returns 403 "Organization has been deactivated" for ALL roles including ORG_OWNER. Only platform admins can reactivate. |
| Member status is SUSPENDED | `requireOrgAccess` returns 403 "Membership is suspended". The member exists but cannot access any org resources. |
| Member status is PENDING | Same as SUSPENDED: 403 "Membership is pending". Must be activated by an admin before access is granted. |
| Role downgrade | Changing a member from ORG_ADMIN to ORG_LEARNER immediately restricts their API access. Dashboard nav updates on next page load. Audited in `OrgAuditLog` with action `ROLE_CHANGE`. |
| ORG_OWNER transfer | Platform admin can set another member to ORG_OWNER and demote the original. There is no constraint limiting ORG_OWNER count per org. |
| ADMIN user who is also an org member | The ADMIN bypass triggers first (line 365 in `auth-helpers.ts`). The user gets the synthesized ORG_OWNER stub, not their actual membership role. This is intentional -- platform admins always have full access. |
