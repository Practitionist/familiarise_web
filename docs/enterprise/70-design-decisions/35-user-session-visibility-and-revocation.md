---
title: A user sees their own sessions; nobody else sees the tokens
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-27
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
   derived label, `lastSeenAt`, `isCurrent`, `isImpersonated` — never
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
   user routes, the staff door, the moderation ban path and the cap.
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
   device survives is not a reset. The current session survives so the
   user is not signed out of the device they are holding.
7. **Cap of 10, eventually consistent.** `MAX_CONCURRENT_SESSIONS`
   with a total-order eviction (`createdAt, id`) under a Serializable
   retry. Generous on purpose (phone + laptop + tablet is normal);
   the cap is hygiene, not the security gate — `authLimiter` owns
   brute force. Raising it is a product decision.
8. **Revocation propagates in four tiers.** A provider-owned visible-tab
   tick finds revocation with no focus needed (authoritative, so ~5 min
   worst case, jittered per tab so open tabs do not stampede the session
   read; hidden tabs skip free); same-browser tabs via the instant
   `session-revoked` BroadcastChannel ping; cross-device within one
   tab-switch via a throttled focus re-check; cross-device within the
   poll interval via the opt-in Redis counter (`sess:revsig:{userId}`,
   ships DISABLED). The tick is the only trigger that pays full price —
   `disableCookieCache` plus `customSession` is ~4 uncached Prisma
   round trips, and the call goes over HTTP so `React.cache` does not
   apply — which is why it is minutes, not seconds, and why the seconds
   answer is the opt-in poll. Every tier funnels into
   one classifier, and the classifier never reads a failed lookup as
   a revocation (#1716, client-side): error → refetch and stay put.
9. **`lastSeenAt` is honest.** Last server-validated activity, ±5 min
   (throttled touch; the cookie cache means most requests never reach
   the DB). The UI says "last seen", never "active now".

## Alternatives considered

Calling `authClient.listSessions()` / `revokeSession()` from the
browser was rejected: raw tokens in the page in both pinned versions.
Bumping `session.freshAge` to make 1.7's `listSessions` usable was
rejected: the same value gates `changePassword`, so a 30-day freshness
window would let a month-old stolen session change the password.
A single "sessions" grant covering staff revoke was rejected: the
back-office matrix already separates seeing (`users.read`) from
destroying (`users.moderate`), and this is exactly the case it exists
for. A short session TTL instead of a cap was rejected on the same
grounds as ADR 10 (constant UX cost for a rare event).

## Consequences

The device list is now the account-takeover triage surface: a user who
sees a device they don't recognize ends it, changes their password
(which sweeps the rest), and is done without support. What we pay:
every permission-adjacent surface now has a session story to keep in
sync (the `session-revoked` ping, the classifier, the cap), and the
`lastSeenAt` touch is one more write on the hot path — throttled to
one per session per 5 min per lambda, but a write all the same.
Revisit the cap if the device list ever shows rows the cap should have
eaten (the `create.after` hook is eventually consistent by design), and
revisit the Redis poll default if takeover triage ever needs
faster-than-a-tab-switch cross-device propagation.
