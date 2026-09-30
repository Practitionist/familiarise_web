---
title: A user sees their own sessions; nobody else sees the tokens
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-30
---

# ADR 35 — User session visibility and revocation

## Context

A signed-in user had exactly one session control: a destructive "log out
everywhere" button (`SessionsSection`, no list, no per-device revoke).
Meanwhile the session table already carried everything a device list
needs — `ipAddress` and `userAgent` are populated by BetterAuth's
internal adapter on every create — and the BetterAuth endpoints that
look like the answer (`listSessions`, `revokeSession`) are unusable
from the browser: in 1.6.5 _and_ 1.7.6, `listSessions()` returns the
raw session **token** per device, and `revokeSession` accepts **only**
the token (upstream `sessionId` support was never merged). Shipping
either to the browser turns any XSS into a takeover of every device.
The 1.7 line additionally gates `listSessions` on `freshSessionMiddleware`
(default 24h from creation), which 403s our 30-day sessions — one more
reason the upgrade (#1855) is orthogonal to this decision.

The forces: the user needs to see where they are signed in and end
sessions they don't recognize (account-takeover triage is the whole
point); a session token must never leave the server; an organization
must not gain a window into a member's devices (ADR 20's line extends
here); staff need enough visibility to resolve "someone else is in my
account" tickets without gaining a silent kick button.

## Decision

**A user sees their own sessions in full. Nobody else sees a token.**

1. **User device list.** `GET /api/user/sessions` returns the caller's
   unexpired sessions through `SESSION_PUBLIC_SELECT`
   (`lib/auth/session-select.ts`): id, timestamps, `ipAddress`,
   derived label, `lastSeenAt` (= `updatedAt`), `isCurrent`, `isImpersonated` — never
   `token`, never the raw `userAgent` string (a fingerprint; only the
   coarse "Chrome on Windows" label crosses). `__tests__/security/
session-payload-allowlist.test.ts` pins both the select keys and the
   mapper output, the same tripwire ADR 20 sets for org content.
2. **Per-device revoke.** `DELETE /api/user/sessions/[id]` deletes by
   `(id, userId)` with `deleteMany` — the `userId` in the `where` IS
   the ownership proof, and a concurrent second revoke is a 0-count
   success, not a throw. Foreign/gone ids answer 200 `{ revoked: 0 }`,
   never 404 (which would leak row existence across users). Revoking
   your own current session is allowed and reported as
   `currentSessionEnded` so the client signs out cleanly.
3. **One choke point.** `lib/auth/session-revoke.ts` owns every end:
   user routes, the staff door and the moderation ban path.
   Direct Prisma is correct for system-initiated revokes: BetterAuth's
   admin `revokeUserSessions` endpoint is caller-scoped (it checks the
   _calling_ admin's session and cannot join a transaction). This
   corrects ADR 10's reasoning — the admin plugin IS installed, but
   the conclusion (no hard kill _from inside a system transaction_)
   stood for the wrong reason.
4. **Organizations see nothing.** No org surface lists, counts, or
   otherwise exposes a member's auth sessions — same rule as ADR 20's
   content half, for the same reason (a member who believes their
   employer watches their devices uses the product differently).
5. **Staff see, admin acts.** `GET .../admin/users/[userId]/sessions`
   (`users.read`, OPERATORS) shows the list for takeover triage; `POST
.../revoke` (`users.moderate`, ADMIN_ONLY, `reason` + OpsActionLog
   row) ends sessions. Staff act through the moderation ban path,
   which shares the same helper. Ending someone else's sessions is a
   destructive act on their account — it needs the admin grant, not
   the support grant.
6. **Password change ends other sessions.** OWASP: a reset the stolen
   device survives is not a reset. `changePassword({ revokeOtherSessions:
   true })` does it in the same request; the current session survives
   so the user is not signed out of the device they are holding.
7. **Revocation is read from the database, not pushed.** The cookie
   cache is off, so every server read sees a deleted row, ban or role
   change on the next request. An open tab on another device learns on
   its next server request or on tab focus (a 30 s-throttled probe of
   `GET /api/user/sessions/current`). Same-browser tabs share one cookie
   and so one session; the existing login/logout BroadcastChannel ping
   covers them.
8. **A failed lookup is never a revocation.** The probe is tri-state —
   200 active, 401/403 revoked or suspended, 503 unknown — because
   BetterAuth's `/get-session` answers `200 null` for a failed lookup
   too. The client signs out only on 401/403 (#1716, client-side).
9. **No raw tokens anywhere.** `disabledPaths` blocks the plugin's
   `/list-sessions`, `/admin/list-user-sessions`,
   `/admin/revoke-user-session` and `/admin/revoke-user-sessions` over
   HTTP; staff roles hold no `session:*` permission; `customSession`
   strips `session.token` from the payload.
10. **"Last active" is BetterAuth's `updatedAt`.** Day-granular
    (`updateAge` = 1 day); the UI says "Active in the last day" / "Last
    active N days ago", never "active now". The device label is derived
    from `userAgent` at read time. No extra columns, no hot-path write.

## Alternatives considered

Calling `authClient.listSessions()` / `revokeSession()` from the
browser was rejected: raw tokens in the page in both pinned versions.
Bumping `session.freshAge` to make 1.7's `listSessions` usable was
rejected: the same value gates `changePassword`, so a 30-day freshness
window would let a month-old stolen session change the password.
A single "sessions" grant covering staff revoke was rejected: the
back-office matrix already separates seeing (`users.read`) from
destroying (`users.moderate`), and this is exactly the case it exists
for. A short session TTL was rejected on the same grounds as ADR 10
(constant UX cost for a rare event).

### Alternatives rejected (built, then removed in #1857)

- **Visible-tab 5-minute tick.** Paid a full uncached session read per
  open tab for a case (visible, untouched, revoked) where the tab can
  read nothing new anyway.
- **Redis revocation-signal counter + poll route.** Always-on Upstash
  traffic, a route, a limiter exemption and an env knob to beat
  "next focus" by seconds; nobody needed that.
- **`session-revoked` BroadcastChannel ping.** Same-browser tabs share
  the session, so the login/logout ping already covers them.
- **Per-user session cap (10, Serializable eviction).** Hygiene with no
  security value (`authLimiter` owns brute force), plus a
  `session.create.after` hook on the sign-in path.
- **`Session.lastSeenAt` / `Session.deviceLabel` columns.** A throttled
  write on every request and a push-before-traffic migration, to show
  data `updatedAt` and `userAgent` already give us.
- **Cookie cache (5 min).** Saved one indexed lookup per read at the
  cost of honouring revocation, bans and role changes up to 5 min late.

## Consequences

The device list is the account-takeover triage surface: a user who
sees a device they don't recognize ends it, changes their password
(which sweeps the rest), and is done without support. What we pay:
every session read is a database lookup (one more indexed query per
request than with the cookie cache), and a revoked device that stays
visible and untouched keeps showing its last rendered page until the
next request or focus. `getCachedSession()` and the eslint rule on bare
`getSession()` stay so that re-enabling the cookie cache cannot
silently make a sensitive read stale. Revisit the cookie cache if
session reads show up in database load; revisit push-style propagation
only if takeover triage ever needs faster than next-request/next-focus.
