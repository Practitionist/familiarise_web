---
title: Session-generation clock over session revocation
band: 70-design-decisions
audience: sde3
status: superseded
last-reviewed: 2026-09-30
---

# ADR 10 — Role changes bump a session-generation counter instead of revoking sessions

> **Superseded (#1878).** `User.sessionGeneration` is gone. With the cookie
> cache off, `customSession` reloads memberships on every request, so nothing
> read the counter. See
> [02-jit-and-session-refresh](../20-iam-and-security/02-jit-and-session-refresh.md)
> and [ADR 36](35-auth-schema-freeze.md).

## Context

BetterAuth's session cookie carries a snapshot of the user's
`organizationMemberships[]`, built by the `customSession` hook, and the
cookie's `updateAge` is 24 hours. When an operator changes a member's role
— promotes a LEARNER to MANAGER, demotes an OWNER, or removes a member
entirely — that snapshot is stale: without intervention the user keeps
acting under the old role payload for up to a day. The catastrophic
version is a demoted OWNER continuing to act as OWNER, or a removed member
continuing to reach the dashboard, for 24 hours. The platform needed those
role changes to take effect promptly without inflicting a forced logout on
users mid-call, and without turning every authenticated request into a
guaranteed database round-trip.

## Decision

Every membership mutation that affects the effective permission set bumps
a monotonic counter on the user row, and the session hook re-reads
memberships rather than revoking the session.
`bumpUserSessionGeneration(tx, userId)` increments
`User.sessionGeneration` by 1 (`{ increment: 1 }`, an atomic Prisma
update, not a read-modify-write) inside the same transaction as the
mutation — on the add/reactivate, role/status/department change, removal,
and invitation-accept paths (see [JIT & session
refresh](../20-iam-and-security/02-jit-and-session-refresh.md) §2). The
`customSession` hook in `lib/auth.ts` reads the live row's
`sessionGeneration` on every session lookup (`liveSessionGeneration`) and
re-loads memberships from the database *unconditionally* — the
`memberships.findMany` always runs (`prisma.membership.findMany({ where: {
status: "ACTIVE", userId } })`). Because memberships are always re-read,
the user's effective permissions update on the next round-trip with no
forced logout. The marker carried in the session payload
(`additionalFields.sessionGeneration`) is what client code can compare
against its cached payload to *detect* staleness; the always-on refetch is
what actually *corrects* it. Today the marker is not yet used as a
skip-the-refetch fast-path — that optimization is noted as future work in
`lib/auth.ts`.

"Next round-trip" is literal: BetterAuth's cookie cache is off
(`session.cookieCache.enabled: false`, #1857), so every server session
read re-runs `customSession`. The dangerous case — a downgraded OWNER or a
removed member — is handled by the **same** generation bump, not by a hard
session kill: removal, downgrade, and soft-suspend all bump
`sessionGeneration`, and the removed member's `organizationMemberships`
drops on their next request. BetterAuth's `admin` plugin is installed, but
its `revokeUserSessions` endpoint is **caller-scoped** (it runs
`adminMiddleware` plus a `session:["revoke"]` check against the *calling*
admin's session) and cannot join the membership transaction, so it is not
the primitive for system-initiated changes.

## Alternatives considered

We considered revoking the session on every role change (full logout,
re-authenticate). It lost on UX cost relative to the marginal security
benefit. For the common case — a benign promotion or department move —
logging the user out mid-session is a heavy, jarring interruption
(potentially mid-call), and the new capabilities don't justify it. A hard
logout is not used for any membership mutation, removal/downgrade
included: dropping the membership on the next request already cuts access
without signing the user out of the rest of the product mid-call.

We considered short session TTLs — make the cookie expire quickly so stale
roles can't persist. It lost on UX and load together: a short TTL forces
frequent re-authentication for every user regardless of whether their role
ever changes, paying a constant cost to cover a rare event. The counter
pays the refetch cost only when a session is actually looked up.

We originally kept BetterAuth's 5-minute cookie cache to avoid a
guaranteed two-query round-trip (live user row + `memberships.findMany`)
on every page load and API call. #1857 turned it off: `customSession`
already queried Prisma on every read, so the cache saved one indexed
lookup while letting revocation, bans and the dangerous removal/downgrade
case lag by up to five minutes.

A design note on *why a counter and not a boolean*: concurrent role
mutations (a script bulk-promoting interns) race against a boolean "stale"
flag — the first reader clears it and later mutations are lost. A
monotonic counter incremented atomically inside each mutation's
transaction can never lose a concurrent bump, so each session can
unambiguously compare "I've seen up to N" against the current row value.

## Consequences

The main cost is a database read on every authenticated request (the
cookie cache is off). The other is the discipline requirement: every
permission-affecting mutation path must remember to call
`bumpUserSessionGeneration` inside its transaction; forget it on one path
and that mutation's effect is delayed all the way to BetterAuth's 24h
`updateAge` rotation — which is exactly the failure mode the failure-mode
table in the JIT doc tells operators to chase. There is also residual
subtlety in that the counter is currently observability-only (the
unconditional refetch is what does the work), so the marker's presence in
the payload can mislead a reader into thinking it gates the refetch when
it does not yet.

Revisit this decision if `customSession`'s unconditional
`memberships.findMany` becomes a measured hot-path cost under high SSO
sign-in load — at which point the planned fast-path (skip the refetch when
`liveSessionGeneration` matches the payload's marker) should be
implemented so the counter starts earning its keep, trading the always-on
refetch for a cheap counter comparison. Re-enabling the cookie cache is the
other lever, but it reopens a staleness window (up to `maxAge`) for the
dangerous cases too.

## Addendum (2026-09-27) — #1856: human-initiated hard revokes

Earlier revisions of this ADR said the `admin` plugin was not installed;
it always was (see Decision for why it still is not the primitive here).
Human-initiated revokes (the user's own device list, the
`users.moderate` staff door) hard-revoke through the shared choke point
in `lib/auth/session-revoke.ts`. The removal/downgrade transitions
deliberately do not; if that UX call ever flips, the primitive is
`revokeAllUserSessions`, not a new mechanism. See ADR 35.
