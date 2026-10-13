---
title: JIT auto-join & session refresh
band: 20-iam-and-security
audience: sde3
status: live
last-reviewed: 2026-10-10
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

The sso() plugin (`@better-auth/sso` 1.7.7) calls our `provisionUser` hook
(`lib/sso/plugin-options.ts`) after the OIDC callback has created or found
the user, linked the account and created the session, but before it sets the
session cookie. The hook first runs the IdP claim checks
(`lib/sso/idp-claims.ts`: `email_verified`, Google `hd`, Entra `xms_edov`);
a refusal deletes the account link this login made and fails the callback.
It then calls `provisionSsoMembership` (`lib/sso/jit-membership.ts`), which
writes the typed `Membership` directly, and stamps `SsoProvider.provenAt` on
the first SSO login by an active OWNER (`lib/sso/provider-proof.ts`). There is no BetterAuth
organization plugin and no `Member` table. Users created by SSO are
`emailVerified=true`.

Concretely: a new graduate student signs in to **IIT Madras** via the campus
IdP for the first time. The IdP asserts their identity, BetterAuth creates
the User + Account + Session, and `provisionUser` mints a `LEARNER`
membership (the locked `defaultRoleForAutoJoin`) before the redirect, or the
role of a pending invitation for that email, which it marks accepted. No
admin touched anything. Before the dashboard, `lib/auth-guard.ts` sends a
user with an active membership who has not finished onboarding to
`/onboarding/gate` (date of birth, 18+, and consent), never to the consumer
wizard. (IIT Madras is a seeded org; the IdP wiring is the
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
  BA->>JIT: provisionUser({ user, token, provider })
  JIT->>JIT: assertIdpClaims (email_verified, hd, xms_edov)
  JIT->>DB: Membership exists for (userId, provider.organizationId)?
  Note over JIT,DB: yes → no-op (REMOVED / SUSPENDED rows are left alone)
  JIT->>DB: org status gate (SUSPENDED / DEACTIVATED refused)
  JIT->>DB: Serializable tx — seat cap (PENDING_VERIFICATION) +<br/>applyMembershipRoleEffects + Membership.create
  Note over JIT,DB: P2002 = a concurrent login already joined;<br/>any other error fails the callback
  BA-->>S: session cookie + redirect ✅
```

`provisionUserOnEveryLogin` is on, so the claim checks run on every login,
a user who already had a password account and links SSO still gets the
membership, and a join refused by the seat cap succeeds once a seat frees up.
The existing-row check keeps the repeat to one indexed lookup.

### Invariant 1 — Role floor is LEARNER

`OrganizationSSOSettings.defaultRoleForAutoJoin` is locked at
`z.literal("LEARNER")` (`lib/labels/org-labels.ts:JitDefaultRoleSchema`),
so an uninvited SSO user can never land above the bottom of the ladder.

The PATCH handler at `app/api/organizations/[orgId]/sso/route.ts`
rejects any other value with 400. The settings UI shows a locked
"Learner" label.

If an org needs a new SSO user above LEARNER, the admin either invites
that email with the role first (JIT applies a pending invitation's role
and logs `INVITE_ACCEPTED`) or promotes them via
`/dashboard/organization/[orgId]/members` after first sign-in
(`MEMBER_ROLE_CHANGED`).

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

### Sessions are read from the database on every request

BetterAuth's cookie cache is off (`session.cookieCache.enabled: false` in
`lib/auth.ts`), so every server session read re-runs `customSession`, which
loads the user's memberships from the database. A promotion, demotion or
removal applies on the user's next request, with no forced logout and no
marker to bump. The cost is one memberships query per authenticated request.
Turning the cookie cache back on would let a demoted or removed member keep
the old `organizationMemberships[]` snapshot until the cookie refreshed.

The read is tri-state. `getSession()` (`lib/auth-server.ts`) and
`lookupSession()` (`lib/auth-session-lookup.ts`) return a session or null,
and throw `SessionLookupFailedError` when the lookup itself failed; API
routes answer that with `503 SESSION_LOOKUP_FAILED` and `Retry-After: 2`, and
`/api/auth/get-session` answers the same 503, so an outage never signs anyone
out.

Human-initiated revokes (the user's device list, the staff Team page) still
hard-revoke sessions through `lib/auth/session-revoke.ts`.

### Lifetimes

`lib/auth/session-lifetime.ts` sets the lifetime when the session is created
and clamps it on every refresh:

| Session                                 | Lifetime                                          |
| --------------------------------------- | ------------------------------------------------- |
| Consumer                                | 30 days, sliding (`updateAge` 1 day)              |
| SSO sign-in for an enforced domain      | 24 hours absolute from sign-in                    |
| Operator (STAFF/ADMIN) with 2FA enabled | 12 hours absolute from sign-in, 2-hour idle limit |
| Operator without 2FA                    | 1 hour, enough to enrol                           |

The full design is
[ADR 34](../70-design-decisions/34-user-session-visibility-and-revocation.md).

---

## §3 — Code anchors

- **Fresh memberships per request:** `lib/auth.ts` `customSession` (cookie cache off)
- **Tri-state read:** `lib/auth-server.ts:getSession`, `lib/auth-session-lookup.ts:lookupSession`, `lib/auth/session-lookup-error.ts`
- **Lifetimes:** `lib/auth/session-lifetime.ts`
- **IdP claim checks:** `lib/sso/idp-claims.ts:assertIdpClaims`
- **JIT auto-join:** `lib/sso/jit-membership.ts:provisionSsoMembership`, wired as the sso() `provisionUser` hook in `lib/sso/plugin-options.ts`
- **Role floor schema:** `lib/labels/org-labels.ts:JitDefaultRoleSchema`
- **API gate on settings:** `app/api/organizations/[orgId]/sso/route.ts:PatchBodySchema`

---

## §4 — Operator-facing rules

- After enabling SSO, a user who signs in for the first time becomes a
  LEARNER in the org, unless a pending invitation for their email names
  another role. Admins promote anyone else explicitly via the Members page.
- Removing or suspending a member whose email is on one of the org's
  verified domains ends their sessions immediately.
- Role changes propagate to active sessions on the next request.
  No "please re-log-in" message; the user just sees their new
  capabilities appear.
- Member removal takes effect on the next request. The removed user
  doesn't have to be told to log out; their `organizationMemberships`
  array drops the org silently.

---

## §5 — Failure modes + how to detect them

The table below maps the symptoms you are most likely to observe back to their probable cause and the fix for each.

| Symptom                                                                | Likely cause                                                                                   | Fix                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| SSO callback fails with a server error and no session cookie           | JIT auto-join transaction failed (non-P2002 error). Check server logs for the thrown error.    | Investigate root cause — DB connection, RLS, FK. The narrowed catch surfaces it; the next sign-in retries. |
| New SSO user signs in but has no org membership                        | A gate skipped the join: org SUSPENDED / DEACTIVATED, or PENDING_VERIFICATION at the seat cap. | Look for the `SSO` category `JIT auto-join skipped` system event for the org.                              |
| User keeps acting as old role after promotion, across several requests | The cookie cache was turned back on in `lib/auth.ts`.                                          | Set `session.cookieCache.enabled: false`.                                                                  |
| SSO callback refused with `SSO_EMAIL_NOT_VERIFIED`                     | The IdP did not vouch for the email (Entra: `xms_edov` missing).                               | Add `xms_edov` as an optional ID-token claim in the app registration.                                      |
| Users see "couldn't confirm your session" and a 503                    | The session lookup failed (database fault or cold start); `SESSION_LOOKUP_FAILED`.             | Transient; clients retry after 2 s. Check database health if it persists.                                  |
| Settings page shows a role dropdown for `defaultRoleForAutoJoin`       | A regression of the LEARNER lock. Schema must be `z.literal("LEARNER")`.                       | Re-check `JitDefaultRoleSchema` + the SSO settings page UI block.                                          |

---

## Deprecated & Superseded Approaches

- **`sessionGeneration` counter and `bumpUserSessionGeneration`.** Mutation
  paths bumped a per-user counter so a cached cookie would refresh. Removed:
  nothing read it once the cookie cache was off.
- **Any non-privileged `defaultRoleForAutoJoin`.** The field once accepted
  roles up to `OWNER`, so the first SSO user could become co-owner. Replaced by
  the `LEARNER` lock.
- **Two-valued session reads (`getSession(true)`, `getCachedSession`).** A
  failed lookup read as signed out. Replaced by the tri-state read above.
