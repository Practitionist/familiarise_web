# Sessions and Devices

| Field         | Value                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Stable                                                                                                                                                                                                                                                                                                     |
| Audience      | All engineers                                                                                                                                                                                                                                                                                              |
| Last reviewed | 2026-09-27                                                                                                                                                                                                                                                                                                 |
| Source files  | `lib/auth/session-select.ts`, `lib/auth/session-revoke.ts`, `lib/auth/device-label.ts`, `lib/auth/session-cap.ts`, `lib/auth/last-seen.ts`, `app/api/user/sessions/`, `app/api/admin/users/[userId]/sessions/`, `components/dashboard/account/SignInSecuritySection.tsx`, `providers/AuthSyncProvider.tsx` |

## 1. Background

A signed-in user has N live sessions (phone, laptop, tablet) as N rows
in the `sessions` table. They need to see them and end the ones they
don't recognize — that is the account-takeover triage surface. The
BetterAuth endpoints that look like the answer are unusable from the
browser: in 1.6.5 _and_ 1.7.6, `listSessions()` returns the raw session
**token** per device, and `revokeSession` accepts **only** the token
(upstream `sessionId` support was never merged). Shipping either to the
browser turns any XSS into a takeover of every device. So every list
and every revoke in this app goes through our own routes, and a
session token never leaves the server. The policy half lives in
[ADR 35](../../enterprise/70-design-decisions/35-user-session-visibility-and-revocation.md).

## 2. Design

### 2.1 The visibility boundary

`lib/auth/session-select.ts` defines `SESSION_PUBLIC_SELECT` — id,
timestamps, `ipAddress`, `userAgent`, `deviceLabel`, `lastSeenAt`,
`impersonatedBy` — and `toPublicSession()`, which emits the label
(persisted, else derived), the IP, `lastSeenAt`, and the `isCurrent` /
`isImpersonated` flags. `token` is absent by construction; the raw
`userAgent` string is read only to derive the label and never crosses.
`__tests__/security/session-payload-allowlist.test.ts` pins both key
sets — adding `token` (or any new column) to either fails the suite.

### 2.2 The revocation choke point

`lib/auth/session-revoke.ts` owns every end: `revokeSessionById`
(per-device; `(id, userId)` in the `where` is the ownership proof),
`revokeUserSessionsExcept` (revoke-others, keeps the caller's row),
`revokeAllUserSessions` (ban, erasure, staff — transaction-safe, takes
the ambient `tx`). All three use `deleteMany`, so a concurrent second
revoke is a 0-count success, never a throw: revocation is idempotent
by construction, and unknown ids answer 200 `{ revoked: 0 }`, never
404 (which would leak row existence across users).

Direct Prisma — not `auth.api.revokeUserSessions` — is correct for
system-initiated revokes: the plugin endpoint is caller-scoped (it
checks the _calling_ admin's session) and cannot join a transaction.

### 2.3 Row metadata

`Session.deviceLabel` + `Session.lastSeenAt` are nullable (additive
under the #705 freeze, no backfill). The label is stamped by
`session.create.after` (awaited PK update — deliberately NOT merged into
the insert, so a stamp failure never fails sign-in) via the
dependency-free `deriveDeviceLabel()`. Note the limit: the INSERT itself
still requires the columns until the push, because the regenerated client
selects all model fields by default — no hook placement avoids that.
(`lib/auth/device-label.ts`); rows predating the deploy fall back to
read-time derivation. `lastSeenAt` starts at creation and advances via
the throttled touch in `lib/auth/last-seen.ts`, fired from
`lib/auth-server.ts` without await: in-process 5-min gate per session
(production runs `PG_POOL_MAX=1`) plus a null-or-stale SQL predicate
so N lambdas collapse into no-ops. Semantics: last _server-validated_
activity, ±5 min — the UI says "last seen", never "active now".

### 2.4 Cap

`MAX_CONCURRENT_SESSIONS = 10`, enforced in `session.create.after`
(fire-and-forget, Sentry-reported, never fails sign-in) by
`enforceSessionCapForUser()`: keep the N newest under the total order
`(createdAt, id)` — `createdAt` alone ties within a millisecond —
inside a Serializable retry. Eventually consistent by design; hygiene,
not the security gate (`authLimiter` owns brute force).

### 2.5 Propagation

Every revoke funnels into one classifier in `AuthSyncProvider`
(`classifyUnexpectedSignOut`): one authoritative `disableCookieCache`
re-check; error → refetch and stay put (a failed lookup is never a
revocation, #1716 client-side); user present → cookie-cache race,
refetch to recover; confirmed null → `forgetAuthState()` +
`signOutEverywhere("/auth/signin?reason=session-revoked")`, which the
sign-in page renders as a notice. Three triggers: the
`session-revoked` BroadcastChannel ping from the revoking tab
(same-browser; the channel never crosses devices), a throttled (30s)
`visibilitychange` re-check (cross-device, one tab-switch), and the
opt-in Redis counter poll (`sess:revsig:{userId}`,
`NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS`, default 0 = off).

### 2.6 Password change

`PasswordSection` POSTs `revoke-others` after a successful
`changePassword`: a reset the stolen device survives is not a reset.
The current session survives; the toast says whether other devices
were signed out.

### 2.7 Back office

`GET .../admin/users/[userId]/sessions` (`users.read`, OPERATORS) for
takeover triage; `POST .../revoke` (`users.moderate`, ADMIN_ONLY,
`reason` + OpsActionLog row via the `withOpsAction` gateway door) to
end one (`sessionId`) or all sessions. Staff see, admin acts; staff
act through the moderation ban path, which shares the helper.

## 3. Operational Concerns

- `npm run db:push` runs once, at merge, by the orchestrator — the two
  columns are additive, but a push is still a production operation on
  the shared Postgres. Push-before-traffic is mandatory: the
  regenerated client selects all model fields by default, so ANY build
  of this code 500s sign-ins against a database without the columns.
  Never route sign-in traffic to an unpushed build (this bit us on the
  #1857 preview).
- `NEXT_PUBLIC_*` is baked at build time: changing the poll interval
  needs a rebuild, same as `NEXT_PUBLIC_APP_URL`.
- The device list is `take: 25` and the cap holds ~10; if either ever
  needs raising, the allowlist test does not care, but the UI list
  rendering does — keep them in step.

## 4. Edge Cases & Foot-Guns

1. **Never call `authClient.listSessions()` from the browser.** It
   returns raw tokens in our pinned versions. The lint rule does not
   cover this — the allowlist test and this doc do.
2. **Never read a failed lookup as a revocation**, server or client:
   503/`SESSION_LOOKUP_FAILED` (server) and `getSession` error (client)
   both mean "could not ask". Only a confirmed null signs out.
3. **`session.create.after` cannot fail sign-in.** It is `void` +
   catch by contract; awaiting it would serialize sign-ins on the
   single production connection.
4. **The Redis poll default is off for a reason.** Turning it on is
   always-on Upstash traffic per visible tab; the focus check already
   covers revocation within one tab-switch.

## 5. Related Docs

- [ADR 35](../../enterprise/70-design-decisions/35-user-session-visibility-and-revocation.md) — the policy: who sees what, and why the token never crosses
- [03-sessions-and-hooks.md](./03-sessions-and-hooks.md) — lifecycle, hooks, cookie cache
- [04-rate-limiting.md](./04-rate-limiting.md) — `sessionMgmtLimiter`, the extended auth rule
- [ADR 10](../../enterprise/70-design-decisions/10-session-generation-clock.md) — addendum: the admin plugin was always installed
