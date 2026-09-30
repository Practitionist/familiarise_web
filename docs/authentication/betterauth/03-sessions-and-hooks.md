# Sessions and Hooks

| Field         | Value                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status        | Stable                                                                                                                                                                                                                                                                                                                           |
| Audience      | All engineers                                                                                                                                                                                                                                                                                                                    |
| Last reviewed | 2026-09-30                                                                                                                                                                                                                                                                                                                       |
| Source files  | `lib/auth.ts`, `lib/auth-server.ts`, `lib/auth-guard.ts`, `lib/auth-client.ts`, `lib/auth-broadcast.ts`, `providers/AuthSyncProvider.tsx`, `app/layout.tsx`, `components/Navbar.tsx`, `app/api/user/sessions/current/route.ts` |

## 1. Background

Sessions are server-side Postgres rows — no JWT. This doc covers the session lifecycle, the three database hooks, the `customSession` enrichment path, and the two membership tables.

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
  Session expires 30 days after its last bump (sliding)
  Session "touched" (expiresAt/updatedAt) at most once per 24 hours
  Cookie cache: off — every read validates against the DB
  Expired rows swept nightly (jobs/cleanup/cleanup-auth-tokens.ts)
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

3. **Revocation from another device (#1856).** Every tab in a browser shares one cookie and so one session, so the login/logout ping above is all same-browser sync needs. For another device, the provider asks `GET /api/user/sessions/current` (200 active / 401 no session / 403 suspended / 503 lookup failed) when the tab becomes visible (throttled to once per 30 s) and whenever the session unexpectedly resolves to null. Only 401/403 signs out, to `/auth/signin?reason=session-revoked`; 503, other errors and network failures refetch and stay put (#1716 client-side). It deliberately does not classify on `/get-session`: `customSession` answers `200 null` for a failed lookup as well as a missing session. See `09-sessions-devices.md`.

## 3. Operational Concerns

### When to Use `getSession(true)`

Pass `true` to `getSession()` (sets `disableCookieCache`) for role-gated, PII or finance reads and for fields that were just mutated (e.g., `onboardingCompleted` after onboarding submit). The cookie cache is currently off, so both forms read the DB, but the distinction keeps those reads fresh if the cache is ever re-enabled.

### Two Membership Tables

| Table        | Owned by   | Role type         | Purpose                                                     |
| ------------ | ---------- | ----------------- | ----------------------------------------------------------- |
| `Member`     | BetterAuth | Free-form string  | Invitation tokens, BetterAuth org plugin internals          |
| `Membership` | Our code   | `MemberRole` enum | Source of truth for role, status, profile links, department |

**Bridge field:** `Membership.betterAuthMemberId` links to `Member.id`. Always keep both in sync.

## 4. Edge Cases & Foot-Guns

1. **ConsulteeProfile is lazy.** Don't assume every user has one. Use `ensureConsulteeProfile()` before any consumer action.
2. **Hook errors are non-fatal.** The `user.create.after` hook wraps everything in try/catch. A failing welcome email won't block signup.
3. **Session enrichment is per-request.** Membership changes are visible on the next request, not the current one.

## 5. Related Docs

- [01-architecture.md](./01-architecture.md) — Plugin chain, entry points
- [09-sessions-devices.md](./09-sessions-devices.md) — Device list, revocation, cross-device sign-out
- [sso/README.md](./sso/README.md) — SSO enforcement deep dive
- [docs/authorization/](../../authorization/) — `requireOrgAccess` and role hierarchy
