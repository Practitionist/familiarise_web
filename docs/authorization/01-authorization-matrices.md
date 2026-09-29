# The four authorization matrices

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Sibling doc | [`02-b2c-entitlements.md`](./02-b2c-entitlements.md) for the plan ladder in depth |
| Source files | `lib/auth/backoffice-permissions.ts`, `lib/auth/org-permissions.ts`, `lib/auth/role-ranks.ts`, `lib/entitlements/plan-entitlements.ts` |

## 1. Background

This folder documents **what a user may do**. That question has four answers in
this codebase, held in four places, and the tempting move is to merge them. This
document is the argument against that, because the four are not four views of
one thing — they are four different questions that happen to arrive in the same
request.

| # | Matrix | Cardinality | Key | Source |
|---|---|---|---|---|
| 1 | `UserRole` | 5 values | `User.role` | `prisma/schema.prisma:6618` |
| 2 | `MemberRole` × `OrgSurface` | 7 × 57 | `Membership.role` | [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts) |
| 3 | `UserRole` × `BackofficeSurface` | 5 × 37 | `User.role` | [`lib/auth/backoffice-permissions.ts`](../../lib/auth/backoffice-permissions.ts) |
| 4 | `B2CPlan` × `Entitlement` | 4 × 14 | the buyer's plan | [`lib/entitlements/plan-entitlements.ts`](../../lib/entitlements/plan-entitlements.ts) |

A fifth axis exists and is **not** in this folder: the session count, which is a
property of one *purchased subscription* and is owned by
`subscriptionEntitlement()` in [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts)
(#1766). §6 is about why that one is deliberately not a rung on matrix 4.

## 2. Scope

| In scope | Out of scope |
|---|---|
| What each matrix authorises and where it is enforced | The plan ladder's contents — see [`02-b2c-entitlements.md`](./02-b2c-entitlements.md) |
| Why there are four and they are not merged | `PlanLevel`, which is a catalogue facet and gates nothing |
| Why a matrix beat a rank ladder | The `Refusal` rail — see [`docs/errors/01-refusals.md`](../errors/01-refusals.md) |
| The capability gates and the 401/403/404/409 conventions ([`README.md`](./README.md) §7–§8) | |

## 3. Matrix 1 — `UserRole`: the platform axis

| Value | What it means |
|---|---|
| `CONSULTEE` | The default. `admin({ defaultRole: "CONSULTEE" })` |
| `CONSULTANT` | A person who delivers |
| `STAFF` | Support and moderation. Privileged, bounded |
| `ADMIN` | The account that answers for the irreversible ones |
| `ORG_WORKSPACE` | Enterprise org operator — manages orgs, no booking or consulting (#1132) |

**What it authorises.** Platform-level operator reach. Not a hierarchy: the
*only* two privileged values are `ADMIN` and `STAFF`, and
`isPrivileged()` is true for exactly those. `CONSULTANT`, `CONSULTEE` and
`ORG_WORKSPACE` are mutually exclusive product shapes, not rungs.

**Where it is enforced.** Two places, and the split is the point.
`requireAdminAuth` / `requireStaffAuth` / `requirePrivilegedAuth` in
[`lib/auth-helpers.ts`](../../lib/auth-helpers.ts) answer the coarse question —
and they are only correct where `ADMIN` and `STAFF` genuinely agree.
Everywhere they differ, the answer is matrix 3.

## 4. Matrix 2 — `MemberRole`: the organisation axis

7 roles, 57 surfaces, and a rank ladder that is **display order only**.

| Role | Rank | Role | Rank |
|---|---|---|---|
| `OWNER` | 100 | `EXPERT` | 40 |
| `MAINTAINER` | 80 | `SUPPORT` | 30 |
| `BILLING_ADMIN` | 70 | `LEARNER` | 20 |
| `MANAGER` | 60 | | |

**What it authorises.** What a member of one organisation may do inside it.
`ORG_PERMISSIONS: Record<OrgSurface, ReadonlySet<MemberRole>>` is the single
source of truth; the sidebar, the page guards and the API routes all read it, so
a surface cannot drift into the "tab shown, page redirects, API 403s" state the
2026-07 role audit found nine of.

**Where it is enforced.** `hasOrgPermission(role, surface)`,
`hasAnyOrgPermission`, and `rolesWithOrgPermission` — consumed by
`requireOrgAccess(orgId, …)` and by the layout's visibility check. A jest pin
walks `app/api/organizations/**` and fails on a handler with no matrix key or a
raw rank check.

**The rank ladder survives as an ordering, not a permission.**
[`lib/auth/role-ranks.ts`](../../lib/auth/role-ranks.ts) is explicit: *"Display
order for org roles — never an authorization input."* Two readers remain, and
both are ordering questions: picking the most operator-like org to land on
(`lib/labels/org-labels.ts`) and choosing one role when a SCIM user sits in
several mapped groups (`lib/scim/resource-user.ts`).

## 5. Matrix 3 — `BackofficeSurface`: the internal axis

37 surfaces, and a policy stated once at the top of the file:

- **STAFF own support end-to-end** — tickets, feedback, moderation,
  appointments, user verification. This is the job.
- **STAFF read every money surface and mutate none of it.** A support agent who
  cannot see a payment cannot resolve a billing ticket; one who can issue a
  refund is not a support agent.
- **STAFF read recording metadata; ADMIN alone plays a recording** (#1270). The
  split is `recordings.read` / `recordings.play`, and the asymmetry is
  deliberate: the session content belongs to the two people who agreed to record
  it, not to the operator.
- **ADMIN alone executes money, owns org lifecycle and platform config, and
  takes the destructive user actions.**

`refunds.manage` is admin-only while `refunds.read` is not;
`payments.manage` likewise; `users.moderate` (ban / role change / force
sign-out) is admin-only while `users.read` and `users.verify` are not.

`team.read` (#1927) is the newest row and the shape to copy. It is split out of
`users.read` because "who else is on staff" is a normal ticket while a roster
listing every operator's 2FA state, last login and live session count is
reconnaissance for the door that suspends them. Its **mutations** — invite,
revoke, suspend, reactivate — deliberately reuse `users.moderate` rather than a
`team.manage` key, because they are the same act as "role change / delete
someone's access" and a second key for the same act is a second place to get the
policy wrong.

**Where it is enforced.** `requireBackofficeSurface(surface)` in
`lib/auth-helpers.ts`, backed by `hasBackofficePermission(role, surface)`. A
bare `isPrivileged(session.user.role)` in a route is not merely coarse — it
makes the grant invisible to the file that is supposed to enumerate every grant.
If a surface needs a role distinction, add the key.

**Why it exists at all.** Admin and staff were two ~85 %-identical dashboards
whose only difference was which route tree you landed in. Merging them into one
`(backoffice)/[tree]` (#1527) means the difference has to live somewhere real.

## 6. Matrix 4 — `B2CPlan` × `Entitlement`: what was paid for

Four rungs (`BASIC`, `EXTENDED`, `COMPREHENSIVE`, `CUSTOM`) and 14 capabilities.
**This section states only the axis, not the ladder** — the rungs, the
cumulative invariant, the `publish ⊆ permanentStorage` relationship, the two
refusal statuses and the `Refusal`-shaped call sites are all in
[`02-b2c-entitlements.md`](./02-b2c-entitlements.md), and they are not repeated
here.

**What it authorises.** A *paid capability*, and nothing about the person.
"Upgrade your plan to unlock this" is the whole sentence. It is keyed on what the
buyer purchased, not on who they are, which is why the four axes are composed at
the consumer and never ranked against each other: a refusal from this matrix
means *"your plan does not include this"*, never *"your role is too low"*.

**Where it is enforced.** `requireEntitlement` / `entitlementRefusal` from
`lib/entitlements/`, consumed by whatever route owns the gate. It is deliberately
**Prisma-free and free of server-only imports**, so a client component may read
`hasEntitlement(b2cPlan, capability)` — while the recommended shape is still to
read the boolean in the server component that owns the gate and pass it down.

**Why the key is not `PlanLevel`.** `PlanLevel` is
`BEGINNER | INTERMEDIATE | ADVANCED | ALL_LEVELS` and describes *the offering the
expert authored*. It is a catalogue facet used to sort browse results, it is
author-supplied, and it gates nothing for anyone. A ₹500 beginner course and a
₹50,000 beginner course are the same `PlanLevel`, and an advanced course is not
a *better* plan — it is a *harder* one. §5 of the entitlements doc has the full
argument; the one-line version is that a label table is not an authorization
axis, and `lib/labels/plan-labels.ts` is the standing proof.

## 7. Why four, and why not merged

### The load-bearing reason: privilege here is not one-dimensional

A rank comparison is a total order. Our privileges are not, and the org ladder
is the proof that has the sharpest teeth:

> **`BILLING_ADMIN` outranks `MANAGER` numerically (70 > 60) yet must see
> *fewer* operational things.**

And the same table breaks the other direction too: `SUPPORT` (30) sees **more**
than `EXPERT` (40) on operations surfaces. An org has an **operations track**
(`MANAGER`, `SUPPORT`), a **finance track** (`BILLING_ADMIN`), and **member
roles** (`EXPERT`, `LEARNER`) that are not a track at all — they are the people
being served. `70 > 60` is true and means nothing. A rank ladder can only answer
"is this role at least that role", and every interesting question about
`BILLING_ADMIN` is "what is this role *not* allowed to see".

`MAINTAINER` (80) outranking `BILLING_ADMIN` (70) while holding **no money
write** is the same fact from the other side. #1851 moved every org gate onto the
matrix and the jest pin refuses a rank check under `app/api/organizations`.

### Why not BetterAuth's `ac` / `hasPermission`

The obvious move is to express all of this with the plugin's access-control
statements, which is what the `admin` plugin is for — and `lib/auth.ts` *does*
wire them (`roles: { ADMIN: adminAc, STAFF: staffAc, user: userAc }`,
`adminRoles: ["ADMIN", "STAFF"]`). Three reasons it is the wrong home anyway.

**1. `ac` is a statement list per role, which is a rank ladder wearing a
different hat.** A statement is a set of verb/resource strings, and a role is a
set of statements. To express "BILLING_ADMIN must *not* see operations" you have
to enumerate everything it *may* see and hope nothing is left over. That is
deny-by-omission, and the omission is invisible in review: there is no row
saying "and nothing else". A matrix row is deny-by-default, because a surface
with no row does not exist.

**2. `ac` has no org scoping.** It answers "may this *role* do X" and has no
notion of *which* organisation. `MAINTAINER` of org A and `MAINTAINER` of org B
are the same string. The org axis is inherently two-keyed — `(orgId, role)` —
and a statement list cannot be scoped per row of a `Membership` table.

**3. `hasPermission` has a live defect, and we should not put a security guard
on it.** better-auth issue **#7822** reports that `hasPermission` skips the
*dynamic* roles map for role names that collide with the plugin's built-in ones,
so a role literally called `admin` or `user` is authorised from the built-in
`defaultRoles` statement regardless of what the `roles` configuration says.

In the installed `better-auth@1.6.5` the mechanism is visible in
`node_modules/better-auth/dist/plugins/admin/has-permission.mjs`:

```js
const acRoles = input.options?.roles || defaultRoles;
for (const role of roles) if (acRoles[role]?.authorize(input.permissions)) return true;
```

and `defaultRoles` is `{ admin: adminAc, user: userAc }` — **lowercase**. Our
enum is uppercase (`ADMIN`, `STAFF`), and `lib/auth.ts` supplies an explicit
`roles` map with uppercase keys, so today the two do not collide. The shape is
live, though: renaming `ADMIN` to `admin` would silently promote it to the
plugin's full `adminAc` statement, including `impersonate-admins` and
`set-password`, and the failure would be a *grant*, not a refusal — the class of
bug that is found in an incident rather than in review.

None of the four matrices uses `hasPermission` as its guard. The plugin's
statements are wired for the plugin's own endpoints; our own guards read our own
maps. That separation is the mitigation, and it is also why the two-`React`
tables are not the place a third-party authorisation library gets introduced.

### The deliberate non-merge: session caps are not a plan rung

This is the one that gets re-proposed roughly once a quarter, so it is worth
stating with its consequence.

A **B2C session cap belongs to a purchased subscription, not to a plan rung.**
One person on `COMPREHENSIVE` may hold three subscriptions from three different
experts, each with its own `sessionsTotal`, its own cycle and its own expiry.
`subscriptionEntitlement()` in `lib/booking/entitlement.ts` is the ONE counter
every surface reads (#1766): it freezes `sessionsTotal` at purchase and derives
cycles from it.

Add a `sessionsRemaining` to `PLAN_LIMITS` and there are two answers to *"how
many sessions are left"*. That is not a style disagreement — **two answers is
how an allocator oversells a subscription.** The allocator writes to one
counter; the gate reads the other; a customer who bought three sessions is told
by the gate that they have none because their plan rung does not include a
number that describes a different object. There is no reconciliation, because
the two numbers are not comparable.

So matrix 4 declares capabilities, and `planLimit` returns `null` for unlimited —
a real answer, not "unknown". A caller that cannot tell those two apart will
tell an unlimited customer they have hit a limit. Session counts are not a
`PlanLimit`; they are `lib/booking/entitlement.ts`, and every session limit
routes through the counter.

### What a fifth axis would look like, and why there isn't one yet

A `User.plan` column does not exist. `User` has no plan column and
`ConsulteeProfile` (schema:3334) carries only `careerStage`,
`budgetPreference`, `isIndependent` and a GST code, so `B2CPlan` is declared
locally in `lib/entitlements/plan-entitlements.ts` and closed. When the enum
lands in the schema, the union becomes a type-only import and every `Record` in
the module is already exhaustive over it — so the new rung is a compile error
until someone has decided what it grants.

## 8. The four axes side by side

| | Platform | Organisation | Back office | Plan |
|---|---|---|---|---|
| **Key** | `User.role` | `Membership.role` | `User.role` | the buyer's plan |
| **Shape** | 5 values | 7 × 57 matrix | 5 × 37 matrix | 4 × 14 matrix |
| **Answers** | "is this person an operator?" | "what may this member do in this org?" | "which internal surface may this operator reach?" | "what has this customer paid for?" |
| **Enforced by** | `requireAdminAuth` / `requireStaffAuth` | `requireOrgAccess` | `requireBackofficeSurface` | `requireEntitlement` |
| **Composed with** | capability gates | capability gates | the impersonation block | nothing — it is not about the person |
| **Never merged because** | the other three are per-tenant or per-purchase | the platform axis has no org | the back-office axis is internal-only | the other three are not about money |

The composition rule is the last row of that table: a route that needs two axes
checks both, and neither is allowed to imply the other. A platform `ADMIN`
reaching an org endpoint is a *synthesized* OWNER membership for
`requireOrgAccess` — and capability gates still apply, so an admin hitting a
WALLET-only endpoint on an INVOICE org gets a **404**, because that endpoint
genuinely does not exist for that org shape. Authority to look is not authority
to call a route that does not apply.

## 9. Open items

| # | Item | Why it is open |
|---|---|---|
| 1 | `B2CPlan` has no persisted home | Schema change owned outside this folder. Until then callers must supply the rung. |
| 2 | Two recording routes still gate inline instead of naming an entitlement | Both routes belong to another owner; `lib/entitlements/` is additive by design. A handler that infers the gate is a handler whose entitlement cannot be grepped. |
| 3 | The `retentionDays` constant lives in a user-facing string | The `14` in the transfer route's copy is the stale one; the entitlements table is the first coded home. |
| 4 | No test walks the declaration rule | The list of route-level entitlement gates does not exist yet, so there is nothing to walk. |
| 5 | `hasPermission` (#7822) is not pinned by a test | The mitigation is that no guard uses it. A pin asserting "no route calls `authClient.admin.hasPermission`" would make that structural rather than remembered. |

## 10. Related docs

- [`README.md`](./README.md) — the helper inventory, the capability gates and the
  401/403/404/409 conventions, including the structural-404 pattern.
- [`02-b2c-entitlements.md`](./02-b2c-entitlements.md) — the plan ladder, the
  cumulative invariant, the refusal shapes and how to add a rung.
- [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts) — the one
  session counter this folder does not duplicate.
- [`../authentication/betterauth/04-errors.md`](../authentication/betterauth/04-errors.md)
  — why a refusal's code must be one the client already knows, which is why the
  entitlement gates reuse `PLAN_FEATURE_NOT_INCLUDED` / `PLAN_LIMIT_REACHED`.
- [`../enterprise/20-iam-and-security/01-sso-and-authentication.md`](../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — `enforceSSO`, which is a *policy* about an axis, not a role.
