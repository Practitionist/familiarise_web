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

## `requireBackofficeSurface(key)`

> **The permission matrix.** The answer comes from `BACKOFFICE_PERMISSIONS` in `lib/auth/backoffice-permissions.ts`, so a role grant is visible in the one file that lists every grant.

Use this for every route under `/api/admin/**` and `/api/staff/**`. It is the only role gate a back-office route has: there is no helper that asks "is this an admin" or "is this an admin or staff" directly, so every grant is a key in the matrix. A refused role gets 403 with `code: "FORBIDDEN"`. A mutation that must leave an audit row uses `withOpsAction` (`lib/backoffice/ops-action-log.ts`), which calls this helper and then writes the `OpsActionLog` row with the operator's reason. The matrix, its policy and the list of routes on each key are in [the authorization matrices](../authorization/01-authorization-matrices.md).

A route that has no back-office screen of its own still names a key with the same people. For example, `/api/admin/system-events`, `/api/admin/exchange-rates` and `/api/admin/support/health` ask for `systemJobs.manage`, and `/api/admin/support/compliance-report` asks for `compliance.manage`; both keys are ADMIN only.

An operator's own action that is not a back-office surface, such as recording their own consent at `POST /api/user/consent`, uses `requireApiAuth()` and then `isPrivileged(role)`, and answers 403 `FORBIDDEN` to anyone else.

```ts
export async function GET() {
  const auth = await requireBackofficeSurface("analytics.read");
  if (auth.error) return auth.error;
  // ... runs for exactly the roles the matrix lists for that key
}
```

## `isPrivileged(role)`

> **A boolean check for ADMIN or STAFF.** For inline conditionals only.

Not a route helper: a boolean function that takes a role string. Use it to branch inside a handler (for example, "operators see all rows, consultants see their own rows only"), or for an operator's self-service route as above. A back-office route uses `requireBackofficeSurface(key)` instead.

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

- `forbiddenResponse(message?, code?)` → 403, with `code` in the body when given

Use these when you need to return an error outside one of the auth helpers (e.g., "found the resource but the state is wrong").

## Decision tree

```
Is the route public (no login required)?
├─ YES → no helper needed. middleware.ts lets it through.
└─ NO → does it require a specific role?
         ├─ A back-office route (/api/admin/**, /api/staff/**)
         │    ├─ An audited write (needs a reason and an OpsActionLog row) → withOpsAction(key, action, …)
         │    └─ Anything else → requireBackofficeSurface(key)
         ├─ The resource owner OR a privileged operator → requireApiAuth + checkOwnership
         ├─ Event participants + operators (consult/subscription/webinar/class) → requireApiAuth + authorizeEventAccess
         └─ Any authenticated user → requireApiAuth
```

## Org-scoped routes

Org-scoped routes use `requireOrgAccess(orgId, { permission: "<key>" })`, which requires an active membership in the organization whose role holds the named key of the org permission matrix in `lib/auth/org-permissions.ts`. There is no rank comparator and no OWNER-only wrapper; an owner-only route names an OWNER-only key such as `org.delete`. See [the authorization guide](../authorization/README.md) for the full option list.

## Error bodies and unknown paths

Every 4xx JSON body carries a sentence a person can read in `error` and a stable `code` a client can branch on, for example `{ "error": "Trial session not found", "code": "NOT_FOUND" }`. A schema failure answers `code: "VALIDATION_FAILED"` with the issues in `details`, malformed JSON answers 400 `MALFORMED_JSON` (`readJsonBody` in `lib/api/parse.ts`), and a refused back-office role answers 403 `FORBIDDEN` with `BACKOFFICE_FORBIDDEN_MESSAGE`. The sentence never names a route path or a bare schema word such as "Required".

A path under `/api` that no route claims answers a JSON 404, `{ "error": "Not found", "code": "NOT_FOUND" }`, with `Cache-Control: no-store`, from the catch-all `app/api/[...notFound]/route.ts`. It exports `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`. Next.js matches a static route first, then dynamic routes from the most to the least specific, so every real route (including `auth/[...all]` and every webhook) outranks it; `__tests__/api/api-not-found-catch-all.test.ts` checks that with Next's own route sorter. The catch-all sits inside the middleware matcher (`/api/(.*)`), so an unknown path still passes the maintenance gate and the client-IP stamp first. A method a real route does not export still answers 405 from that route, not 404.

## See also

- [ADR — Drop the AdminLevel enum](../decisions/2026-04-08-drop-admin-level.md)
- [`lib/auth-helpers.ts`](../../lib/auth-helpers.ts) — source
- [`lib/api/operators/`](../../lib/api/operators) — shared operator utilities (extracted from duplicated admin/staff routes)

## Deprecated & Superseded Approaches

- **Two raw role guards** (one for ADMIN only, one for ADMIN or STAFF) once sat beside `requireBackofficeSurface` in `lib/auth-helpers.ts`. Every route that called them moved onto a matrix key with the same role set, and both were deleted, so a grant can no longer hide outside `BACKOFFICE_PERMISSIONS`. Do not add a role-named helper back; add or reuse a key.
- **A strict STAFF-only guard and an `unauthorizedResponse` helper** were described here but never existed in `lib/auth-helpers.ts`.
