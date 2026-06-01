# JIT auto-join & session refresh

> **Scope.** How org memberships materialize when a user signs in via
> SSO for the first time (JIT auto-join), and how role changes
> propagate to active sessions without forcing logout.
>
> **Audience.** Engineers touching `lib/auth.ts:customSession`,
> `lib/api/organizations/membership-transitions.ts`, the
> `/api/organizations/[orgId]/members` route family, or
> `OrganizationSSOSettings`.
>
> Companion docs: [`15-sso-and-authentication.md`](./15-sso-and-authentication.md)
> for the SSO enforcement chain, [`18-rate-limiting.md`](./18-rate-limiting.md)
> for the limiter posture.

---

## §1 — JIT (Just-In-Time) auto-join

When a user authenticates against an org's IdP for the very first time,
BetterAuth's SSO plugin writes a row to the `members` table (the
BetterAuth Member shim) but does NOT create the typed `Membership` row
the rest of the codebase reads. The bridge is in
`lib/auth.ts:customSession`:

```ts
const bareMembers = await prisma.member.findMany({
  where: { userId: user.id, membership: null },
  ...
});
for (const bm of bareMembers) {
  const defaultRole = bm.organization.ssoSettings?.defaultRoleForAutoJoin ?? "LEARNER";
  await prisma.$transaction(async (tx) => {
    const roleEffects = await applyMembershipRoleEffects(tx, {
      userId: user.id,
      role: defaultRole,
      preloadedProfiles, // pre-fetched at the top of customSession; B.7
    });
    await tx.membership.create({ /* role, FKs, betterAuthMemberId */ });
  });
}
```

Three invariants make this safe:

### Invariant 1 — Role floor is LEARNER

`OrganizationSSOSettings.defaultRoleForAutoJoin` is locked at
`z.literal("LEARNER")` (`lib/labels/org-labels.ts:JitDefaultRoleSchema`,
audit Phase A.1). Pre-Phase-A.1, this field accepted any
non-privileged role including `OWNER` — which meant the first user to
sign in via SSO became co-owner of the org. Catastrophic privilege
grant.

The PATCH handler at `app/api/organizations/[orgId]/sso/route.ts`
rejects any other value with 400. The settings UI shows a locked
"Learner" label instead of the prior 3-option Select.

If an org needs to promote a new SSO user beyond LEARNER, the
admin does it explicitly via `/dashboard/organization/[orgId]/members`
after first signin. That path is audit-logged
(`MEMBER_ROLE_CHANGED`); JIT auto-join would not be.

### Invariant 2 — Catch is narrowed to P2002

The transaction's catch block only swallows `Prisma.PrismaClientKnownRequestError`
with code `P2002` (unique-constraint race — another concurrent session-
create won the membership). Every other error re-throws. Audit Phase A.3.

Pre-fix, the bare `catch {}` swallowed network drops, Supabase RLS
denials, FK violations — anything. Users could end up with a
session cookie but no Membership row, landing on a broken dashboard
where every org-scoped API call 403'd.

### Invariant 3 — Profile FKs pre-loaded

`applyMembershipRoleEffects` accepts `preloadedProfiles` so the
customSession hook fetches the user's `consulteeProfileId` +
`consultantProfileId` once and passes them through the bareMembers
loop. For a user in 10 SSO orgs, this is the difference between 10
redundant `users.findUnique` round-trips per session lookup and zero.
Audit Phase B.7.

---

## §2 — Session refresh after role / membership changes

### The problem

BetterAuth's session cookie has `session.updateAge: 24h`. The cookie
carries a snapshot of `organizationMemberships[]` (built by
`customSession`). If a user's role changes — promoted from LEARNER to
MANAGER, or removed entirely — their session cookie keeps the *old*
role payload for up to 24 hours.

Concrete failure mode: an OWNER demoted to LEARNER could keep
acting as OWNER for 24h. A removed member could keep accessing the org
dashboard for 24h. Both are real bugs, not just hygiene.

### The fix — `sessionGeneration` marker

Every membership mutation that affects the effective permission set
calls `bumpUserSessionGeneration(tx, userId)`:

- POST `/members` (add or reactivate)
- PATCH `/members/[memberId]` (role / status / departmentLabel change)
- DELETE `/members/[memberId]` (soft-delete → REMOVED)
- POST `/invitations/accept` (invitation acceptance)

The helper increments `users.sessionGeneration` by 1 inside the same
transaction as the mutation.

`customSession` reads the live row's `sessionGeneration` on every
session lookup and re-loads memberships from the DB unconditionally.
Since memberships are always fresh, the user's effective permissions
update on the next round-trip — no forced logout needed.

### Why a counter, not a boolean

Concurrent role mutations (e.g. a script bulk-promoting interns)
would race against a boolean "stale" flag — the first reader clears
the flag, and later mutations are lost. A monotonic counter carried
in the session payload (`additionalFields.sessionGeneration`, see
`lib/auth.ts`) means each session can compare "I've seen up to N"
against the current row value, unambiguously.

### Why we don't force logout

The UX cost of "you've been signed out, please log in again" is high
relative to the marginal security benefit. The catastrophic case is
role downgrade with stale OWNER session — and that's already followed
by a member-removal flow which calls BetterAuth's `revokeSession` as a
deliberate kill.

The `sessionGeneration` bump handles the middle case: the membership
is still active, but the role / status changed. Next request reflects
the new permissions; no UX disruption.

### Sequence diagram

```
┌────────┐                ┌─────────┐               ┌─────────────┐
│ OWNER  │                │  API    │               │  Postgres   │
└───┬────┘                └────┬────┘               └──────┬──────┘
    │ PATCH /members/abc        │                          │
    │ { role: "MANAGER" }       │                          │
    ├──────────────────────────▶│                          │
    │                           │ BEGIN tx                 │
    │                           ├─────────────────────────▶│
    │                           │                          │
    │                           │ Membership.update        │
    │                           ├─────────────────────────▶│
    │                           │                          │
    │                           │ users.update             │
    │                           │ sessionGeneration += 1   │
    │                           ├─────────────────────────▶│
    │                           │                          │
    │                           │ COMMIT                   │
    │                           ├─────────────────────────▶│
    │ 200 OK                    │                          │
    │◀──────────────────────────┤                          │
    │                           │                          │
    │ (next request — any URL)  │                          │
    ├──────────────────────────▶│                          │
    │                           │ customSession reads user │
    │                           │ sessionGeneration: N+1   │
    │                           ├─────────────────────────▶│
    │                           │                          │
    │                           │ memberships.findMany     │
    │                           ├─────────────────────────▶│
    │ session.user reflects     │                          │
    │ new MANAGER role          │                          │
    │◀──────────────────────────┤                          │
```

---

## §3 — Code anchors

- **Bump helper:** `lib/api/organizations/membership-transitions.ts:bumpUserSessionGeneration`
- **Schema:** `prisma/schema.prisma model User → sessionGeneration Int @default(0)`
- **Carry in session:** `lib/auth.ts` additionalFields + customSession `liveSessionGeneration`
- **JIT auto-join loop:** `lib/auth.ts:customSession` bareMembers loop
- **Role floor schema:** `lib/labels/org-labels.ts:JitDefaultRoleSchema`
- **API gate on settings:** `app/api/organizations/[orgId]/sso/route.ts:PatchBodySchema`

---

## §4 — Operator-facing rules

- After enabling SSO, the first user from each domain who signs in
  becomes a LEARNER in the org. Admins promote them explicitly via the
  Members page if the user is meant to be a MANAGER / MAINTAINER /
  OWNER.
- Role changes propagate to active sessions on the next request.
  No "please re-log-in" message; the user just sees their new
  capabilities appear.
- Member removal takes effect on the next request. The removed user
  doesn't have to be told to log out; their `organizationMemberships`
  array drops the org silently.

---

## §5 — Failure modes + how to detect them

| Symptom | Likely cause | Fix |
|---|---|---|
| New SSO user can't access the dashboard, session cookie present | JIT auto-join transaction failed (non-P2002 error). Check server logs for the thrown error. | Investigate root cause — DB connection, RLS, FK. The narrowed catch surfaces it. |
| User keeps acting as old role 30+ minutes after promotion | `bumpUserSessionGeneration` not called on the mutation path. | Search route handlers for the mutation; ensure `bumpUserSessionGeneration(tx, userId)` is called inside the tx. |
| `customSession` slow under high SSO sign-in load | The bareMembers loop is running for many orgs without `preloadedProfiles`. | Ensure the pre-fetch at the top of `customSession` is still in place; passes through `preloadedProfiles` to `applyMembershipRoleEffects`. |
| Settings page shows a role dropdown for `defaultRoleForAutoJoin` | A regression of audit Phase A.1. Schema must be `z.literal("LEARNER")`. | Re-check `JitDefaultRoleSchema` + the SSO settings page UI block. |
