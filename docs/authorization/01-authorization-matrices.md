# The three authorization matrices

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Source files | `lib/auth/backoffice-permissions.ts`, `lib/auth/org-permissions.ts`, `lib/auth/role-ranks.ts` |

## 1. Background

This folder documents **what a user may do**. That question has three answers in
this codebase, held in three places, and the tempting move is to merge them. This
document is the argument against that, because the three are not three views of
one thing — they are three different questions that happen to arrive in the same
request.

| # | Matrix | Cardinality | Key | Source |
|---|---|---|---|---|
| 1 | `UserRole` | 5 values | `User.role` | `prisma/schema.prisma:6618` |
| 2 | `MemberRole` × `OrgSurface` | 7 × 57 | `Membership.role` | [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts) |
| 3 | `UserRole` × `BackofficeSurface` | 5 × 37 | `User.role` | [`lib/auth/backoffice-permissions.ts`](../../lib/auth/backoffice-permissions.ts) |

A fourth axis exists and is **not** in this folder: the session count, which is
a property of one *purchased subscription* and is owned by
`subscriptionEntitlement()` in [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts)
(#1766). There is no plan-entitlement matrix; §6 says why a session cap must not
become one.

## 2. Scope

| In scope | Out of scope |
|---|---|
| What each matrix authorises and where it is enforced | Session counts — see `lib/booking/entitlement.ts` |
| Why there are three and they are not merged | `PlanLevel`, which is a catalogue facet and gates nothing |
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
order for org roles — never an authorization input."* One reader remains, and
it is an ordering question: picking the most operator-like org to land on
(`lib/labels/org-labels.ts`).

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
reconnaissance for the door that suspends them. Its **mutations** — add staff,
reset 2FA, suspend, reactivate — deliberately reuse `users.moderate` rather than a
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

## 6. Why three, and why not merged

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

None of the three matrices uses `hasPermission` as its guard. The plugin's
statements are wired for the plugin's own endpoints, and those endpoints are
all in `disabledPaths` (lib/auth.ts), so nothing reachable over HTTP consults
them; our own guards read our own maps. That separation is the mitigation, and it is also why the two-`React`
tables are not the place a third-party authorisation library gets introduced.

### The deliberate non-merge: session caps belong to the subscription

This is the one that gets re-proposed roughly once a quarter, so it is worth
stating with its consequence.

A **B2C session cap belongs to a purchased subscription, not to a plan.**
One person may hold three subscriptions from three different
experts, each with its own `sessionsTotal`, its own cycle and its own expiry.
`subscriptionEntitlement()` in `lib/booking/entitlement.ts` is the ONE counter
every surface reads (#1766): it freezes `sessionsTotal` at purchase and derives
cycles from it.

Add a per-plan session limit anywhere else and there are two answers to *"how
many sessions are left"*. That is not a style disagreement — **two answers is
how an allocator oversells a subscription.** The allocator writes to one
counter; the gate reads the other, and the two numbers are not comparable.
Every session limit routes through the counter.

## 7. The three axes side by side

| | Platform | Organisation | Back office |
|---|---|---|---|
| **Key** | `User.role` | `Membership.role` | `User.role` |
| **Shape** | 5 values | 7 × 57 matrix | 5 × 37 matrix |
| **Answers** | "is this person an operator?" | "what may this member do in this org?" | "which internal surface may this operator reach?" |
| **Enforced by** | `requireAdminAuth` / `requireStaffAuth` | `requireOrgAccess` | `requireBackofficeSurface` |
| **Composed with** | the operator 2FA gate | capability gates | the operator 2FA gate |
| **Never merged because** | the other two are per-tenant or internal | the platform axis has no org | the back-office axis is internal-only |

The composition rule is the last row of that table: a route that needs two axes
checks both, and neither is allowed to imply the other. A platform `ADMIN`
reaching an org endpoint is a *synthesized* OWNER membership for
`requireOrgAccess` — and capability gates still apply, so an admin hitting a
WALLET-only endpoint on an INVOICE org gets a **404**, because that endpoint
genuinely does not exist for that org shape. Authority to look is not authority
to call a route that does not apply.

## 8. Open items

| # | Item | Why it is open |
|---|---|---|
| 1 | `hasPermission` (#7822) is not pinned by a test | No guard uses it, and `__tests__/security/admin-plugin-fenced.test.ts` pins every admin endpoint (including `/admin/has-permission`) to `disabledPaths`. A pin on server-side `auth.api.userHasPermission` calls would close the rest. |

## 9. Related docs

- [`README.md`](./README.md) — the helper inventory, the capability gates and the
  401/403/404/409 conventions, including the structural-404 pattern.
- [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts) — the one
  session counter this folder does not duplicate.
- [`../authentication/betterauth/04-errors.md`](../authentication/betterauth/04-errors.md)
  — why a refusal's code must be one the client already knows.
- [`../enterprise/20-iam-and-security/01-sso-and-authentication.md`](../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — `enforceSSO`, which is a *policy* about an axis, not a role.
