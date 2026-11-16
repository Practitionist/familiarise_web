# Auth helpers for API routes

> Quick reference for route authors. Source: [`lib/auth-helpers.ts`](../../lib/auth-helpers.ts).

All helpers return a discriminated union of either `{ session }` (success) or `{ error }` (a `NextResponse` you should return immediately). Narrow with `if (result.error) return result.error;` and then use `result.session`.

## `requireApiAuth()`

> **Any authenticated user.** No role check.

Use this at the top of any route that needs a logged-in user but doesn't care about their role. Returns the BetterAuth session with all `customSession` enrichments (role, profile IDs, organization memberships, etc.).

```ts
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const session = auth.session;
  // ... session.user.id is guaranteed to exist
}
```

The error it returns has three shapes, and the status is the contract (#1716). A `401` means Better Auth found no session: no cookie, an expired row, or a row that is gone. A `403` means the account is suspended. A `503` with `code: "SESSION_LOOKUP_FAILED"` and a `Retry-After` header means the lookup itself did not complete — a cold-instance stall or a database fault on a cookie that may well be valid — and the client should retry rather than send the user to sign-in. The distinction is made in `lib/auth-session-lookup.ts`: a thrown lookup is a failure unless it is the 401 Better Auth raises when the refresh hook ends the session, and a null with a session cookie present is settled by one indexed read of the `Session` row. The page guards in `lib/auth-guard.ts` make the same distinction and throw `SessionLookupFailedError` to the nearest error boundary instead of clearing the cookie.

## `requireAdminAuth()`

> **Strict ADMIN only.** STAFF gets 403. Do not add a new caller: a new back-office route uses `requireBackofficeSurface(key)` with an ADMIN-only key.

These routes still call it, and each moves onto the matrix with its own screen's pull request:

- `/api/admin/compliance/gst-register` and `/api/admin/compliance/tds-return`
- `/api/admin/erasure-requests/[id]/process` and `/api/admin/erasure-requests/[id]/reject`
- `/api/admin/exchange-rates`
- `/api/admin/newsletter/broadcast`
- `/api/admin/organizations`
- `/api/admin/support/compliance-report` and `/api/admin/support/health`
- `/api/admin/system-events`

```ts
export async function POST() {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  // ... admin-only logic
}
```

## `requirePrivilegedAuth()`

> **ADMIN or STAFF.** Everyone else gets 403. Do not add a new caller: a new back-office route uses `requireBackofficeSurface(key)` with a key both roles hold.

These routes and helpers still call it, and each moves onto the matrix with its own screen's pull request:

- `/api/admin/disputes` and `/api/admin/disputes/[disputeId]`
- `/api/admin/documents`
- `/api/admin/newsletter`
- `/api/admin/payments` and `/api/admin/payments/[paymentId]`
- `/api/admin/refunds`
- `/api/admin/settlements/lines`
- `/api/admin/subscriptions`
- `/api/admin/users` and `/api/admin/users/[userId]`
- `/api/admin/verification` and `/api/admin/verification/[verificationId]`
- `/api/staff/appointments` and `/api/staff/appointments/[appointmentId]/timeline`
- `/api/staff/feedbacks` and `/api/staff/feedbacks/[feedbackId]`
- `/api/staff/moderation/reports`, `/api/staff/moderation/reports/[reportId]` (and its `action` and `unban` doors), `/api/staff/moderation/reviews`, `/api/staff/moderation/reviews/[reviewId]` and `/api/staff/moderation/stats`
- `/api/staff/stats`
- `/api/user/consent`
- the shared readers in `lib/api/operators/` (`invoices.ts`, `payouts.ts`, `stats.ts`, `verification.ts`) and `lib/data/staff-appointments.ts` and `lib/data/staff-stats.ts`

```ts
export async function GET(req: NextRequest) {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;
  const session = auth.session;
  // ... operator logic
}
```

## `requireBackofficeSurface(key)`

> **The permission matrix.** The answer comes from `BACKOFFICE_PERMISSIONS` in `lib/auth/backoffice-permissions.ts`, so a role grant is visible in the one file that lists every grant.

Use this for every back-office route that needs a role distinction, and for any new route in `/api/admin/**` or `/api/staff/**`. The two raw guards above are being retired route by route as each screen moves onto the matrix; do not add a new caller. A route moved in the first back-office pull request is `/api/admin/leads` (`leads.manage`), `/api/admin/trial-pricing` (`trialPricing.manage`), `/api/admin/stats`, `/api/admin/analytics/cancellations` and `/api/staff/metrics` (`analytics.read`) and `/api/admin/maintenance/**` (`maintenance.manage`). A mutation that must leave an audit row uses `withOpsAction` (`lib/backoffice/ops-action-log.ts`), which calls this helper and then writes the `OpsActionLog` row with the operator's reason. The matrix and its policy are in [the authorization matrices](../authorization/01-authorization-matrices.md).

```ts
export async function GET() {
  const auth = await requireBackofficeSurface("analytics.read");
  if (auth.error) return auth.error;
  // ... runs for exactly the roles the matrix lists for that key
}
```

## `requireStaffAuth()`

> **Strict STAFF only.** ADMIN gets 403.

Use this for the (rare) routes that are specifically staff-scoped and where an ADMIN should NOT have access. Examples: a route returning "support tickets assigned to me as a staff member" where an admin wouldn't have that view. Most back-office routes want `requireBackofficeSurface(key)` instead.

If you're about to reach for this helper, ask yourself: "does it make sense for an admin to call this?" If yes, use `requireBackofficeSurface(key)` with a key both roles hold. If no (truly staff-only), use `requireStaffAuth`. As of this ADR landing, **zero routes use `requireStaffAuth`** — it's here for when a future staff-only view appears.

```ts
export async function GET() {
  const auth = await requireStaffAuth();
  if (auth.error) return auth.error;
  // ... staff-only logic (admins rejected)
}
```

## `isPrivileged(role)`

> **Legacy boolean check.** Still useful for inline conditionals.

Not a route helper — just a boolean function that takes a role string. Use it when you need to branch logic inside a handler (e.g., "admins see all rows, consultants see their own rows only"). Prefer the async helpers above when you're guarding a whole route.

```ts
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const where = isPrivileged(auth.session.user.role)
    ? {} // admin sees everything
    : { consultantProfileId: auth.session.user.consultantProfileId };

  const rows = await prisma.consultationPlan.findMany({ where });
  return NextResponse.json({ rows });
}
```

## `checkOwnership(session, resourceOwnerId, profileType)`

> **Boolean ownership check** by profile type.

Used alongside `requireApiAuth()` when the route is scoped to "the resource owner OR a privileged operator." Returns `true` if the user's profile ID for the given type matches the resource owner.

```ts
const auth = await requireApiAuth();
if (auth.error) return auth.error;

const plan = await prisma.consultationPlan.findUnique({
  where: { id: planId },
});
if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });

const isOwner = checkOwnership(
  auth.session,
  plan.consultantProfileId,
  "consultant",
);
if (!isOwner && !isPrivileged(auth.session.user.role)) {
  return forbiddenResponse();
}
```

## `authorizeEventAccess(session, eventType, eventId)`

> **Pre-built authorization for consultation/subscription/webinar/class.**

Checks whether the session user is (a) the consultant who owns the plan, (b) the consultee who requested it, (c) an accepted collaborator (for webinar/class), or (d) a privileged operator. Returns `null` if authorized, or a 403 `NextResponse` to return.

```ts
const auth = await requireApiAuth();
if (auth.error) return auth.error;

const authzError = await authorizeEventAccess(
  auth.session,
  "webinar",
  webinarId,
);
if (authzError) return authzError;
// ... authorized logic
```

## Response helpers

Small utilities that wrap `NextResponse.json` with canonical error shapes:

- `unauthorizedResponse(message?)` → 401
- `forbiddenResponse(message?)` → 403

Use these when you need to return an error outside one of the auth helpers (e.g., "found the resource but the state is wrong").

## Decision tree

```
Is the route public (no login required)?
├─ YES → no helper needed. middleware.ts lets it through.
└─ NO → does it require a specific role?
         ├─ A back-office route (/api/admin/**, /api/staff/**)
         │    ├─ An audited write (needs a reason and an OpsActionLog row) → withOpsAction(key, action, …)
         │    └─ Anything else → requireBackofficeSurface(key)
         ├─ Strict STAFF only (rare; reject admins too) → requireStaffAuth
         ├─ The resource owner OR a privileged operator → requireApiAuth + checkOwnership
         ├─ Event participants + operators (consult/subscription/webinar/class) → requireApiAuth + authorizeEventAccess
         └─ Any authenticated user → requireApiAuth
```

## Org-scoped routes

Org-scoped routes use `requireOrgAccess(orgId, { permission: "<key>" })`, which requires an active membership in the organization whose role holds the named key of the org permission matrix in `lib/auth/org-permissions.ts`. There is no rank comparator and no OWNER-only wrapper; an owner-only route names an OWNER-only key such as `org.delete`. See [the authorization guide](../authorization/README.md) for the full option list.

## See also

- [ADR — Drop the AdminLevel enum](../decisions/2026-04-08-drop-admin-level.md)
- [`lib/auth-helpers.ts`](../../lib/auth-helpers.ts) — source
- [`lib/api/operators/`](../../lib/api/operators) — shared operator utilities (extracted from duplicated admin/staff routes)
