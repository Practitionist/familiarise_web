# Sessions and Hooks

| Field         | Value                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Stable                                                                                                                                                                                                                                                                                                                           |
| Audience      | All engineers                                                                                                                                                                                                                                                                                                                    |
| Last reviewed | 2026-09-27                                                                                                                                                                                                                                                                                                                       |
| Source files  | `lib/auth.ts`, `lib/auth-server.ts`, `lib/auth-guard.ts`, `lib/auth-client.ts`, `lib/auth-broadcast.ts`, `providers/AuthSyncProvider.tsx`, `app/layout.tsx`, `components/Navbar.tsx`, `lib/auth/device-label.ts`, `lib/auth/session-cap.ts`, `lib/auth/last-seen.ts`, `lib/auth/session-revoke.ts`, `lib/auth/session-select.ts` |

## 1. Background

Sessions are server-side Postgres rows — no JWT. This doc covers the session lifecycle, the four database hooks, the `customSession` enrichment path, and the two membership tables.

## 2. Design

### 2.1 Session Lifecycle

```
Sign-up / Sign-in
       │
       ▼
session.create.before hook ──── SSO veto (may throw FORBIDDEN)
       │
       ▼
  Session row created in Postgres
       │
       ▼
  Cookie issued (HTTP-only, opaque)
       │
       ▼
  Every authenticated request:
    1. getSessionCookie() in middleware (cookie presence check)
    2. auth.api.getSession() in handler (DB validation + customSession)
       │
       ▼
  Session expires after 30 days
  Session "touched" (updatedAt) once per 24 hours
  Cookie cache: 5 min compact serialization
```

### 2.2 Database Hooks

**`user.create.after`** — Fires after every signup:

- Creates `CookiePreference` and `NotificationPreference` rows
- Sends welcome email (fire-and-forget — errors logged, not thrown)
- Syncs user to Novu subscriber (fire-and-forget)
- Does **not** create `ConsulteeProfile` (lazy via `ensureConsulteeProfile`)

**`session.create.before`** — Fires before issuing a session cookie on any auth path (credential, OAuth, SSO, signup):

- Calls `shouldRejectSession()` from `lib/sso/enforce-session.ts`
- Looks up the user's email domain in `OrgDomainClaim`
- If domain is enforced (`enforceSSO=true`, verified claim, active org), checks whether user has an `account` row matching one of the org's registered `ssoProvider.providerId` values
- **Fails open** if the org has no providers configured yet (prevents lockout during setup)
- Throws `APIError("FORBIDDEN")` with `code: "SSO_REQUIRED"` if rejected
- The allow path falls through untouched: device metadata is stamped in `session.create.after`, never merged into the insert (a missing column must never brick sign-in, #1856)

**`session.create.after`** — Fires after the session row commits (#1856):

- Awaited `stampSessionDeviceMetadata()`: writes `deviceLabel` + `lastSeenAt` via one PK update (catches failures internally, throttled-reported, so sign-in never fails — awaiting it only costs milliseconds on a rare path and keeps a serverless freeze from dropping it).
- Awaited `enforceSessionCapForUser()` (cap 10, total-order eviction under a Serializable retry, multi-pass convergence for large overflows, just-created session reserved). A floating promise would die with the serverless freeze and never converge — failures are caught and Sentry-reported, so sign-in never fails; overflows past 5×200 keep converging on later sign-ins.

**`account.create.after`** — Fires after linking a non-credential account:

- Sends "account linked" notification email (fire-and-forget)

### 2.3 customSession Enrichment

Every `getSession()` call runs `customSession()`. Three things happen:

**1. SSO Membership Bridge**

BetterAuth's `Member` table (untyped, free-form `role` string) and our `Membership` table (typed `MemberRole` enum) are separate. When an SSO user auto-joins, BetterAuth creates a `Member` row but not our `Membership`. The bridge finds "bare" members (`Member` rows where `membership IS NULL`) and creates the missing `Membership`:

```typescript
// Simplified flow:
const bareMembers = await prisma.member.findMany({
  where: { userId: user.id, membership: null },
});
for (const bm of bareMembers) {
  await prisma.membership.create({
    data: {
      role: org.ssoSettings?.defaultRoleForAutoJoin ?? "LEARNER",
      status: "ACTIVE",
      betterAuthMemberId: bm.id,
      // ...
    },
  });
}
```

> [!WARNING]
> Unique-constraint race conditions on `Membership` creation are caught and silently ignored — two concurrent requests might both try to create the same membership.

**2. Organization Memberships Payload**

Loads all ACTIVE memberships with org metadata. This powers the `OrgSwitcher` and checkout without an extra roundtrip. Shape:

```typescript
{
  (organizationId,
    organizationName,
    organizationSlug,
    organizationLogo,
    role,
    departmentLabel,
    canSponsor,
    canHost,
    fundingSource,
    walletBalance);
}
```

**3. SSO Enforcement Flag (removed)**

This used to mirror the `session.create.before` logic to set `ssoEnforcementFailed: true` on existing sessions. The flag never had a consumer and was removed (#1242) — do not re-introduce it without its consumer. Enforcement lives solely in `session.create.before`.

### 2.4 Auth Guard vs Auth Helper

|                  | `lib/auth-guard.ts`                                                         | `lib/auth-helpers.ts`                                          |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Used in**      | Server components (pages)                                                   | API route handlers                                             |
| **Error style**  | `redirect()` — never returns                                                | `NextResponse.json({ error }, { status })`                     |
| **Functions**    | `requireAuth`, `requireOnboarded`, `requireUserRole`, `requireNotOnboarded` | `requireApiAuth`, `requireAdminAuth`, `requireOrgAccess`, etc. |
| **Session read** | `getSession()` or `getSession(true)`                                        | `getSession(true)` always                                      |

### 2.5 Client Rendering and Cross-Tab Sync

The client reads auth state through BetterAuth's `useSession()` hook, which fetches `/get-session` from the browser only after the page has hydrated. If a component renders the signed-out state while that fetch is in flight, the user sees a flash of the logged-out UI that then swaps to the logged-in UI a moment later. The shared `Navbar` previously did exactly this, which read as broken session persistence even though the cookie was present the whole time.

Two pieces work together to make the rendered auth state correct and consistent across tabs:

1. **Remembered shape, not server seeding.** An earlier version of this doc claimed the root layout resolves the session server-side and passes it as `initialSession`. That was removed (#932): `getSession()` in the root layout invokes `headers()`, forcing the entire app dynamic and stalling even `loading.tsx` skeletons ~20–30s on a cold instance. Instead the Navbar paints the last-known name+avatar from `localStorage` (`lib/auth-broadcast.ts`, `hooks/useRememberedAuth.ts` — name and image ONLY, never an authz signal) while `useSession()` resolves, then reconciles. The brief unknown state renders as a neutral placeholder, not a signed-out flash.

2. **Cross-tab propagation.** BetterAuth's client only broadcasts a session change to other tabs on sign-out and user-update, never on sign-in, and OAuth or SSO logins complete through a full-page redirect with no client fetch hook at all. As a result an already-open tab would not reflect a login elsewhere until it next regained focus (BetterAuth's built-in `visibilitychange` refetch). `AuthSyncProvider` (mounted once in the root layout) closes that gap: it detects this tab's logged-out to logged-in transition and pings peer tabs over a `BroadcastChannel`, and on receiving a ping it calls the `useSession` `refetch` so every consumer re-renders. The helper in `lib/auth-broadcast.ts` falls back to a `storage` event for browsers without `BroadcastChannel`. The provider renders nothing and shares the existing session atom, so it adds no extra `/get-session` request.

3. **Revocation classification (#1856).** When a tab goes from authed to null without initiating it, one authoritative re-check (`disableCookieCache`) classifies: error → refetch and stay put (a failed lookup is never a revocation, #1716 client-side); user present → cookie-cache race, refetch to recover; confirmed null → clean sign-out to `/auth/signin?reason=session-revoked`. Four triggers feed it: the provider's own visible-tab tick (authoritative, ~5 min bound with per-tab jitter, hidden tabs skip free), the `session-revoked` BroadcastChannel ping from the revoking tab (same-browser), a throttled `visibilitychange` re-check (cross-device, one tab-switch), and the opt-in Redis counter poll (`NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS`, default off). See `09-sessions-devices.md`.

## 3. Operational Concerns

### When to Use `disableCookieCache`

Pass `true` to `getSession()` when reading fields that were just mutated (e.g., `onboardingCompleted` after onboarding submit). The 5-minute cookie cache will otherwise return stale data.

### Two Membership Tables

| Table        | Owned by   | Role type         | Purpose                                                     |
| ------------ | ---------- | ----------------- | ----------------------------------------------------------- |
| `Member`     | BetterAuth | Free-form string  | Invitation tokens, BetterAuth org plugin internals          |
| `Membership` | Our code   | `MemberRole` enum | Source of truth for role, status, profile links, department |

**Bridge field:** `Membership.betterAuthMemberId` links to `Member.id`. Always keep both in sync.

## 4. Edge Cases & Foot-Guns

1. **ConsulteeProfile is lazy.** Don't assume every user has one. Use `ensureConsulteeProfile()` before any consumer action.
2. **Hook errors are non-fatal.** The `user.create.after` hook wraps everything in try/catch. A failing welcome email won't block signup.
3. **Session enrichment is per-request.** Membership changes are visible on the next request, not the current one (unless you force a cache bypass).

## 5. Related Docs

- [01-architecture.md](./01-architecture.md) — Plugin chain, entry points
- [sso/README.md](./sso/README.md) — SSO enforcement deep dive
- [docs/authorization/](../../authorization/) — `requireOrgAccess` and role hierarchy
