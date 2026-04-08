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

## `requireAdminAuth()`

> **Strict ADMIN only.** STAFF gets 403.

Use this for routes that mutate platform-level state irreversibly. These are things where a STAFF member accidentally clicking a button in the wrong dashboard tab shouldn't be able to do real damage.

**Routes that must use this:**
- `/api/admin/maintenance/**` — site-wide maintenance mode toggle
- `/api/admin/system-jobs/run` — manual cron triggers
- `/api/admin/newsletter/send` — mass email
- `/api/admin/payouts/process` — real money transfers
- `/api/admin/exchange-rates` (POST only) — FX cache invalidation

```ts
export async function POST() {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  // ... admin-only logic
}
```

## `requireStaffAuth()` / `requirePrivilegedAuth()`

> **ADMIN or STAFF.** Everyone else gets 403.

These are aliases for each other. Use `requirePrivilegedAuth` when the semantics are "any privileged operator" (moderation, support, read-only dashboards). Use `requireStaffAuth` when the route lives under `/api/staff/**` and the name just makes more sense.

**Routes that should use this:**
- All `/api/staff/**` routes
- All `/api/admin/**` routes that are NOT in the `requireAdminAuth` list above
- Read-only endpoints, moderation queues, support ticket views, analytics dashboards

```ts
export async function GET(req: NextRequest) {
  const auth = await requirePrivilegedAuth();
  if (auth.error) return auth.error;
  const session = auth.session;
  // ... operator logic
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

const plan = await prisma.consultationPlan.findUnique({ where: { id: planId } });
if (!plan) return NextResponse.json({ error: "Not found" }, { status: 404 });

const isOwner = checkOwnership(auth.session, plan.consultantProfileId, "consultant");
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

const authzError = await authorizeEventAccess(auth.session, "webinar", webinarId);
if (authzError) return authzError;
// ... authorized logic
```

## Response helpers

Small utilities that wrap `NextResponse.json` with canonical error shapes:

- `unauthorizedResponse(message?)` → 401
- `forbiddenResponse(message?)` → 403
- `unprocessableResponse(message)` → 422

Use these when you need to return an error outside one of the auth helpers (e.g., "found the resource but the state is wrong").

## Decision tree

```
Is the route public (no login required)?
├─ YES → no helper needed. middleware.ts lets it through.
└─ NO → does it require a specific role?
         ├─ Strict ADMIN only (mutates platform state) → requireAdminAuth
         ├─ ADMIN or STAFF (read/moderation) → requirePrivilegedAuth
         ├─ The resource owner OR a privileged operator → requireApiAuth + checkOwnership
         ├─ Event participants + operators (consult/subscription/webinar/class) → requireApiAuth + authorizeEventAccess
         └─ Any authenticated user → requireApiAuth
```

## Future

The following helpers will land with the enterprise PR (PR2):

- `requireOrgAccess(orgId, minRole?)` — active membership in an organization with optional minimum role
- `requireOrgOwner(orgId)` — shorthand wrapper
- `orgRoleSatisfies(actual, minimum)` — boolean comparator

Those need the `OrganizationProfile` / `OrganizationMemberProfile` schema which lives in PR2, so they aren't in this PR.

## See also

- [ADR — Drop the AdminLevel enum](../decisions/2026-04-08-drop-admin-level.md)
- [`lib/auth-helpers.ts`](../../lib/auth-helpers.ts) — source
- [`lib/api/operators/`](../../lib/api/operators) — shared operator utilities (extracted from duplicated admin/staff routes)
