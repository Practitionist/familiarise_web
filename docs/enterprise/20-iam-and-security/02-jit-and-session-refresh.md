---
title: JIT auto-join & session refresh
band: 20-iam-and-security
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# JIT auto-join & session refresh

This document explains how organization memberships materialize when a
user signs in through an org's IdP for the very first time (Just-In-Time
auto-join), and how a role change propagates to an already-active session
without forcing the user to log out. It is written for engineers touching
`lib/sso/jit-membership.ts`, `lib/auth.ts:customSession`,
`lib/api/organizations/membership-transitions.ts`,
the `/api/organizations/[orgId]/members` route family, or the
`OrganizationSSOSettings` model. The companion docs are
[`sso-and-authentication`](01-sso-and-authentication.md), which covers the
SSO enforcement chain, and [`rate-limiting`](03-rate-limiting.md), which
covers the limiter posture.

---

## §1 — JIT (Just-In-Time) auto-join

The sso() plugin calls our `provisionUser` hook
(`lib/sso/plugin-options.ts`) after the OIDC callback has created or found
the user, linked the account and created the session, but before it sets the
session cookie. The hook calls `provisionSsoMembership`
(`lib/sso/jit-membership.ts`), which writes the typed `Membership` directly.
There is no BetterAuth organization plugin and no `Member` table.

Concretely: a new graduate student signs in to **IIT Madras** via the campus
IdP for the first time. The IdP asserts their identity, BetterAuth creates
the User + Account + Session, and `provisionUser` mints a `LEARNER`
membership (the locked `defaultRoleForAutoJoin`) before the redirect. No
admin touched anything; the student's first page load already sees the
membership. (IIT Madras is a seeded org; the IdP wiring is the
operator-configured shape, not part of the seed.)

```mermaid
sequenceDiagram
  autonumber
  actor S as New IIT student
  participant IdP as Campus IdP
  participant BA as BetterAuth (SSO plugin)
  participant JIT as provisionSsoMembership
  participant DB as Postgres
  S->>IdP: first SSO sign-in
  IdP-->>BA: code → token exchange, ID token verified
  BA->>DB: create User + Account + Session
  BA->>JIT: provisionUser({ user, provider })
  JIT->>DB: Membership exists for (userId, provider.organizationId)?
  Note over JIT,DB: yes → no-op (REMOVED / SUSPENDED rows are left alone)
  JIT->>DB: org status gate (SUSPENDED / DEACTIVATED refused)
  JIT->>DB: Serializable tx — seat cap (PENDING_VERIFICATION) +<br/>applyMembershipRoleEffects + Membership.create
  Note over JIT,DB: P2002 = a concurrent login already joined;<br/>any other error fails the callback
  BA-->>S: session cookie + redirect ✅
```

`provisionUserOnEveryLogin` is on. A user who already had a password account
and links SSO is not a "registration", and a join refused by the seat cap
should succeed once a seat frees up; the existing-row check keeps the repeat
to one indexed lookup.

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

### Invariant 2 — Governance gates run once, at sign-in

A SUSPENDED or DEACTIVATED org is refused, and a PENDING_VERIFICATION org
admits at most `UNVERIFIED_ORG_SEAT_CAP` ACTIVE members, counted in the same
Serializable transaction as the insert (retried on P2034 via
`withSerializableRetry`). Each skip writes an `SSO` system event.

### Invariant 3 — No half-provisioned sign-in

The catch only swallows `P2002` on `(userId, organizationId)`. Any other
error propagates out of `provisionUser`, so the plugin fails the callback
before the cookie is set: the user is never signed in without the membership
the IdP promised, the transaction leaves no partial profile or membership
behind, and the next login retries.

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

### The fix: sessions are read from the database on every request

BetterAuth's cookie cache is off (`session.cookieCache.enabled: false` in
`lib/auth.ts`), so every server session read re-runs `customSession`, which
loads the user's memberships from the database. A promotion, demotion or
removal applies on the user's next request, with no forced logout and no
marker to bump. The cost is one memberships query per authenticated request.
Turning the cookie cache back on would reopen the staleness window above.

Human-initiated revokes (the user's device list, the staff Team page) still
hard-revoke sessions through `lib/auth/session-revoke.ts`.

The earlier `sessionGeneration` counter (ADR 10) was removed in #1878: nothing
read it once the cookie cache was off.

---

## §3 — Code anchors

- **Fresh memberships per request:** `lib/auth.ts` `customSession` (cookie cache off)
- **JIT auto-join:** `lib/sso/jit-membership.ts:provisionSsoMembership`, wired as the sso() `provisionUser` hook in `lib/sso/plugin-options.ts`
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

The table below maps the symptoms you are most likely to observe back to their probable cause and the fix for each.

| Symptom | Likely cause | Fix |
|---|---|---|
| SSO callback fails with a server error and no session cookie | JIT auto-join transaction failed (non-P2002 error). Check server logs for the thrown error. | Investigate root cause — DB connection, RLS, FK. The narrowed catch surfaces it; the next sign-in retries. |
| New SSO user signs in but has no org membership | A gate skipped the join: org SUSPENDED / DEACTIVATED, or PENDING_VERIFICATION at the seat cap. | Look for the `SSO` category `JIT auto-join skipped` system event for the org. |
| User keeps acting as old role after promotion, across several requests | `bumpUserSessionGeneration` not called on the mutation path (so the only refresh left is BetterAuth's 24h `updateAge` rotation). | Search route handlers for the mutation; ensure `bumpUserSessionGeneration(tx, userId)` is called inside the tx. |
| Settings page shows a role dropdown for `defaultRoleForAutoJoin` | A regression of audit Phase A.1. Schema must be `z.literal("LEARNER")`. | Re-check `JitDefaultRoleSchema` + the SSO settings page UI block. |
