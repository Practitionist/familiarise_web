# Authorization

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Sibling folder | [`docs/authentication/`](../authentication/) for "who is this user" |
| Source files | `lib/auth-helpers.ts`, `lib/auth-guard.ts`, `lib/auth/backoffice-permissions.ts`, `lib/auth/org-permissions.ts`, `lib/auth/role-ranks.ts`, `lib/entitlements/plan-entitlements.ts` |

## 1. Background

This folder documents the **authorization** subsystem — every code path that answers "what can this user do?" once we know who they are. Authentication (who they are) lives in the sibling folder above.

Authorization is **our code**, not BetterAuth's. The helpers in `lib/auth-helpers.ts` are thin wrappers around session reads and Prisma queries, returning standardized error responses.

> **Read [`01-authorization-matrices.md`](./01-authorization-matrices.md) first if you have not.** There are four authorization matrices in this codebase and this README describes three of them. The fourth — the B2C entitlement ladder, which answers *"what has this customer paid for"* rather than *"who is this person"* — is in [`02-b2c-entitlements.md`](./02-b2c-entitlements.md). The document that explains why there are four, what each one authorises, where it is enforced, and why merging any two of them is the wrong move is the first entry in the table below.

## 2. Scope

| In scope | Out of scope |
|---|---|
| API route auth helpers (`requireApiAuth`, `requireOrgAccess`, etc.) | BetterAuth setup — see `authentication/betterauth/` |
| Platform role hierarchy (ADMIN > STAFF > others) | Session lifecycle, hooks |
| Back-office surface matrix (`BACKOFFICE_PERMISSIONS`, 37 surfaces) | Novu notification targeting |
| Org permission matrix (`ORG_PERMISSIONS`, 7 × 57) | SSO enforcement |
| B2C plan entitlements (4 × 14) | Rate limiting |
| Capability gates (canSponsor, canHost, fundingSource) | OAuth/SSO provider config |
| Error conventions (401 vs 403 vs 404 vs 409) | |

## 3. Where to Start

| # | Section | Reading time |
|---|---|---|
| 1 | [The four matrices](./01-authorization-matrices.md) — the four axes, and why they are not merged | 10 min |
| 2 | [B2C entitlements](./02-b2c-entitlements.md) — what a customer paid for | 10 min |
| 3 | [Platform Roles](#4-platform-roles) | 3 min |
| 4 | [Org Roles](#5-org-role-hierarchy) | 5 min |
| 5 | [API Helpers Inventory](#6-api-helpers-inventory) | 10 min |
| 6 | [Capability Gates](#7-capability-gates) | 5 min |
| 7 | [Error Conventions](#8-error-conventions) | 5 min |


## 4. Platform Roles

Two privileged platform roles gate admin/staff routes:

| Role | Access level | Example routes |
|---|---|---|
| `ADMIN` | Full platform access. Bypasses org membership checks. | `/api/admin/*`, system jobs, maintenance mode |
| `STAFF` | Support operations, moderation queues | `/api/staff/*`, shared admin/staff dashboard |

The `isPrivileged()` helper returns `true` for both. Use the typed helpers instead of inline comparisons:

```typescript
// ✅ Correct
const { session, error } = await requireAdminAuth();       // ADMIN only
const { session, error } = await requireStaffAuth();       // STAFF only
const { session, error } = await requirePrivilegedAuth();  // ADMIN or STAFF

// ❌ Wrong — don't inline role checks
if (session.user.role === "ADMIN") { ... }
```

### The back-office permission matrix

`isPrivileged()` answers a coarse question, and it is the wrong question wherever ADMIN and STAFF should differ. [`lib/auth/backoffice-permissions.ts`](../../lib/auth/backoffice-permissions.ts) is the declared single source of truth for which platform role reaches which internal surface, and `requireBackofficeSurface(surface)` is the guard that consults it. The sidebar, the page guards and the API routes all read the same map, which is what keeps a surface out of the "tab shown, page redirects, API 403s" state.

The policy the matrix encodes is that staff own support end-to-end, read every money surface without mutating any of it, and admin alone executes money, owns org lifecycle and platform config, and takes the irreversible user actions. Two recent additions are worth naming because they are the shape the matrix exists for.

`refunds.manage` is admin-only while `refunds.read` is not, because a staff member resolving a billing ticket needs to see the refund and has no business issuing one.

`recordings.read` and `recordings.play` (#1270) split the same way, and more sharply. A recording is the audio and video of a private session between two people who agreed to record it for each other, not for the platform. Staff hold `recordings.read` and receive status, storage type, duration, timestamps and URL expiry, which is everything a "where is my replay" ticket needs. `recordings.play` — any URL that renders the session — is ADMIN-only, and every read granted by either key writes an audit trail. See [`docs/stream/13-recording-webhooks.md`](../stream/13-recording-webhooks.md#operator-access-admin--staff).

A bare `isPrivileged(session.user.role)` in a route is not merely coarse; it makes the grant invisible to the file that is supposed to enumerate every grant. If a surface needs a role distinction, add the key here rather than branching in the handler.

## 5. Org Role Hierarchy

**Seven** org-level roles, resolved by the matrix in [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts) — 7 × 57 — and *not* by a rank ladder:

| Role | `ORG_ROLE_RANK` | Typical use |
|---|---|---|
| `OWNER` | 100 | Org creator, billing, SSO config, member management |
| `MAINTAINER` | 80 | Day-to-day ops, can manage most settings |
| `BILLING_ADMIN` | 70 | Finance-team operator. Invoices, POs, payouts, rate cards, wallet top-ups, outbound webhooks. **Operator-blind** |
| `MANAGER` | 60 | Department leads, program management |
| `EXPERT` | 40 | Consultants hosted by the org |
| `SUPPORT` | 30 | Read-only support staff |
| `LEARNER` | 20 | Employees/consumers using org-sponsored services |

> [!IMPORTANT]
> The rank column is **display order only** and has been since #1851. It is not
> an authorization input: `BILLING_ADMIN` (70) outranks `MANAGER` (60) yet must
> see *fewer* operational things, and `SUPPORT` (30) sees *more* than `EXPERT`
> (40) on operations surfaces. A rank comparison cannot express either, so a jest
> pin fails on a rank check under `app/api/organizations`. The two remaining
> readers of the numbers — picking the most operator-like org to land on, and
> choosing one role when a SCIM user sits in several mapped groups — are ordering
> questions, not permission ones. See
> [`01-authorization-matrices.md`](./01-authorization-matrices.md#7-why-four-and-why-not-merged).

**Role comparison** uses `hasOrgPermission(role, surface)`:

```typescript
hasOrgPermission("MAINTAINER", "programs.manage");  // true  — governance track
hasOrgPermission("BILLING_ADMIN", "billing.manage"); // true  — finance track
hasOrgPermission("BILLING_ADMIN", "activity.read");  // false — operator-blind, and rank 70 would have said true
hasOrgPermission("LEARNER", "operations.read");      // false
```

> [!IMPORTANT]
> Platform `ADMIN` bypasses org membership entirely. When a platform admin accesses an org endpoint, `requireOrgAccess` synthesizes a stub `Membership` with role `OWNER`. Capability gates (canSponsor, canHost, fundingSource) still apply — an admin hitting a WALLET-only endpoint on an INVOICE org gets a 404. Authority to look is not authority to call a route that does not apply.


## 6. API Helpers Inventory

All helpers live in [`lib/auth-helpers.ts`](../../lib/auth-helpers.ts).

### 6.1 Session Helpers

| Helper | Returns | Use when |
|---|---|---|
| `requireApiAuth()` | `{ session }` or `{ error: 401 }` | Any API route needing a logged-in user |
| `requireAdminAuth()` | `{ session }` or `{ error: 401\|403 }` | Platform admin–only routes (irreversible mutations) |
| `requireStaffAuth()` | `{ session }` or `{ error: 401\|403 }` | Staff-only routes (own support tickets) |
| `requirePrivilegedAuth()` | `{ session }` or `{ error: 401\|403 }` | Shared admin/staff routes (most common) |
| `requireBackofficeSurface(surface)` | `{ session }` or `{ error: 401\|403 }` | Any back-office route where ADMIN and STAFF differ — resolves `BackofficeSurface` against the matrix |

### 6.2 Org Access Helpers

| Helper | Signature | Use when |
|---|---|---|
| `requireOrgAccess(orgId, opts?)` | Returns `{ session, member, org }` or `{ error }` | Any org-scoped API route |
| `requireOrgOwner(orgId, opts?)` | Convenience wrapper — `minimumRole: "OWNER"` | Owner-only operations |

`opts` can be a bare `MemberRole` string or an `OrgCapabilityGate` object:

```typescript
// Simple role check
await requireOrgAccess(orgId, "MAINTAINER");

// Role + capability gate
await requireOrgAccess(orgId, {
  minimumRole: "MANAGER",
  canSponsor: true,
  requireActive: true,
});
```

### 6.3 Ownership Helpers

| Helper | Purpose |
|---|---|
| `checkOwnership(session, resourceOwnerId, profileType)` | Checks if session user owns a resource via their profile ID |
| `authorizeEventAccess(session, eventType, eventId)` | Authorizes access to consultations, subscriptions, webinars, classes. Checks ownership, collaboration, or privileged role. |

### 6.4 Response Helpers

| Helper | Status | When to use |
|---|---|---|
| `forbiddenResponse(msg?)` | 403 | User is authenticated but not authorized |
| `unauthorizedResponse(msg?)` | 401 | No valid session |

## 7. Capability Gates

`OrgCapabilityGate` extends role checks with structural requirements:

| Gate | Type | Effect on failure |
|---|---|---|
| `minimumRole` | `MemberRole` | 403 Forbidden |
| `canSponsor` | `true` | **404** — the API doesn't exist for this org shape |
| `canHost` | `true` | **404** — same |
| `fundingSource` | `FundingSource` | **404** — e.g., WALLET-only endpoint on INVOICE org |
| `requireActive` | `true` | **409** `ORG_NOT_VERIFIED` — org in `PENDING_VERIFICATION` |

> [!NOTE]
> Capability gates return **404, not 403**. This is intentional — a host-only org doesn't have sponsor APIs at all. "Not found" is the honest response (the endpoint genuinely doesn't exist for that org shape), while 403 would imply "you're allowed elsewhere."

## 8. Error Conventions

| Status | Meaning | When used |
|---|---|---|
| **401** | No valid session (unauthenticated) | `requireApiAuth()` with no/stale cookie |
| **403** | Authenticated but not authorized | Wrong role, not a member, membership inactive |
| **404** | Resource doesn't exist OR structural mismatch | Org not found, capability gate failure |
| **409** | State conflict | `ORG_NOT_VERIFIED` (org exists but pre-activation) |
| **422** | Business logic rejection | Valid request but unprocessable |

### The Structural-404 Pattern

When a capability gate fails (e.g., `canSponsor` on a host-only org), the response is 404 — not 403. This mirrors how filesystems surface missing paths. The client sees "this endpoint doesn't exist" rather than "you don't have permission," which is the honest representation.

```typescript
// This org doesn't sponsor → the /sponsor endpoint simply doesn't exist
if (canSponsor === true && !org.canSponsor) {
  return NextResponse.json(
    { error: "This organization does not sponsor bookings" },
    { status: 404 },
  );
}
```

## 9. Common Patterns

### Writing a new org-scoped API route

```typescript
export async function POST(req, { params }) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MANAGER",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  // access.session — the authenticated session
  // access.member  — the Membership row
  // access.org     — the Organization row (with billingAccount)
  // ... your logic
}
```

### Writing a new platform admin route

```typescript
export async function POST(req) {
  const { session, error } = await requireAdminAuth();
  if (error) return error;
  // session.user.role is guaranteed "ADMIN"
}
```

## 10. Edge Cases & Foot-Guns

1. **Never inline role comparisons, and never compare ranks.** Ask the matrix:
   `hasOrgPermission(role, surface)` for a decision, or `requireOrgAccess` /
   `requireBackofficeSurface` for a guard. An inline `=== "OWNER"` misses the
   grants; an inline `ORG_ROLE_RANK[a] >= ORG_ROLE_RANK[b]` misses the
   *refusals*, which is the half the ladder cannot express — `BILLING_ADMIN`
   outranks `MANAGER` and must see less. A jest pin fails on a rank check
   under `app/api/organizations` (#1851).
2. **ADMIN bypass includes capability gates.** An admin calling a WALLET endpoint on an INVOICE org still gets 404. Capability gates are structural (the feature doesn't exist), not authorization (you're not allowed).
3. **Deactivated orgs.** `requireOrgAccess` returns 403 for `DEACTIVATED` orgs regardless of the user's role.
4. **Unique constraint on `userId_organizationId`.** A user can only have one `Membership` per org. The `findUnique` on this composite key is the membership lookup.
5. **A B2C session cap is not a plan rung.** "How many sessions are left" has exactly one home, `subscriptionEntitlement()` in `lib/booking/entitlement.ts` (#1766). Adding a second counter is how an allocator oversells a subscription. See [`02-b2c-entitlements.md`](./02-b2c-entitlements.md#8-numeric-limits).
6. **Don't put a third-party authorisation library on a security guard.** BetterAuth's `hasPermission` has a live defect (#7822) that skips the dynamic roles map for built-in role names. None of the four matrices uses it, and a pin asserting that would keep it that way.


## 11. Related Docs

- [`01-authorization-matrices.md`](./01-authorization-matrices.md) — the four matrices, what each authorises, where each is enforced, and why they are not merged (including why BetterAuth's `ac` / `hasPermission` is the wrong home, and #7822)
- [`02-b2c-entitlements.md`](./02-b2c-entitlements.md) — the B2C plan ladder, its capability matrix, and the deliberate decision that a session cap is **not** a plan rung
- [`docs/authentication/betterauth/`](../authentication/betterauth/) — BetterAuth setup, session model
- [`docs/authentication/betterauth/03-sessions-and-hooks.md`](../authentication/betterauth/03-sessions-and-hooks.md) — Auth guard functions (page-level)
- [`docs/authentication/betterauth/09-failure-modes.md`](../authentication/betterauth/09-failure-modes.md) — what a user sees when Postgres, Redis or the platform is the thing that failed
- [`docs/errors/01-refusals.md`](../errors/01-refusals.md) — the `Refusal` rail the entitlement gates hand their answers to
- [`docs/api/`](../api/) — General API conventions
- [`docs/stream/13-recording-webhooks.md`](../stream/13-recording-webhooks.md#access-control-matrix) — how the recording surfaces apply the back-office matrix, and what a privileged read writes to the audit trail

