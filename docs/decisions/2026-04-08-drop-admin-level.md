# ADR: Drop the `AdminLevel` enum and consolidate admin/staff route auth

- **Status**: Accepted
- **Date**: 2026-04-08
- **Author**: teetangh
- **PR**: `feature/cleanup` → `dev`
- **Closes**: #326

## Context

Two long-standing issues in the platform admin layer:

### 1. `AdminLevel` enum was defined but never consulted

`prisma/schema.prisma` had:

```prisma
model AdminProfile {
  adminLevel AdminLevel
  // ...
  @@index([adminLevel])
}

enum AdminLevel {
  SUPER_ADMIN // Full system access
  ADMIN       // High-level management
  MODERATOR   // Day-to-day operations
}
```

And `schemas/user.ts`, `utils/onboarding.ts`, `utils/onboarding-shared.ts`, `prisma/seedFiles/1a-create-users.ts`, `app/dashboard/admin/settings/page.tsx`, and `app/api/user/[id]/route.ts` all dutifully carried `adminLevel` around. **Zero code anywhere read the value for a permission decision.** Every admin API route treated `UserRole.ADMIN` as full access. Issue #326 tracked implementing a permission matrix for the three levels; it was "MVP-adjacent post-launch" work that never happened.

### 2. Inline session + role checks duplicated across ~46 admin/staff API routes

Every route in `app/api/admin/**` and `app/api/staff/**` had boilerplate like this:

```ts
const session = await getSession();
if (!session?.user?.id) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
const user = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: { role: true },
});
if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

Two routes (`admin/maintenance/route.ts`, `admin/exchange-rates/route.ts`) had their own local `requireAdmin()` helpers with subtly different rules — `maintenance` accepted STAFF (wrong for operational mode), `exchange-rates` was ADMIN-only (correct). There was no shared utility and no enforcement of which routes should be strict ADMIN vs PRIVILEGED (ADMIN+STAFF).

## Decision

Three changes, all in this PR:

### D1: Drop `AdminLevel` entirely

- Remove `enum AdminLevel` from `prisma/schema.prisma`
- Remove `adminLevel` field and `@@index([adminLevel])` from `AdminProfile`
- Remove `AdminLevelEnum` from `schemas/user.ts`, and `adminLevel` from `AdminProfileSchema`
- Remove `AdminLevel` from `utils/onboarding.ts`, `utils/onboarding-shared.ts`, `prisma/seedFiles/1a-create-users.ts`, `app/dashboard/admin/settings/page.tsx`, `app/api/user/[id]/route.ts`

Rationale: pre-MVP, with 1–2 platform staff, the 2-tier distinction between `UserRole.ADMIN` and `UserRole.STAFF` is sufficient. An unused required column adds drift risk and schema clutter.

If granular permissions become necessary later, the right answer is a proper `Permission` / `Role` table pair (or a policy engine like CASL/OSO), not a three-value enum. A future re-introduction would not break this decision — it would add a new mechanism, not resurrect the dead one.

### D2: Introduce shared auth helpers in `lib/auth-helpers.ts`

```ts
// Strict ADMIN only — rejects STAFF. For system jobs, maintenance, exchange
// rates, newsletter, payouts processing.
export async function requireAdminAuth(): Promise<
  { session: Session } | { error: NextResponse }
>;

// Strict STAFF only — rejects ADMIN. For (rare) routes where even an admin
// should not have access. No current routes use this; it's here for the
// future case of staff-specific views that admins shouldn't see.
export async function requireStaffAuth(): Promise<
  { session: Session } | { error: NextResponse }
>;

// ADMIN or STAFF — the most common helper. For read endpoints, moderation
// queues, support ops, and the shared admin/staff dashboard API surface.
export async function requirePrivilegedAuth(): Promise<
  { session: Session } | { error: NextResponse }
>;
```

Each helper enforces exactly one role predicate — the three are strict ADMIN, strict STAFF, and the union. Naming matches the predicate: `requireAdminAuth` is the strict admin gate, `requireStaffAuth` is the strict staff gate, `requirePrivilegedAuth` is the "either one" gate.

All three rely on the session's embedded `role` field (via BetterAuth's `customSession`) and do not re-query the database — one less round trip per admin/staff request.

### D3: Refactor all ~46 admin/staff API routes to use the new helpers

Decision matrix:

**Strict `requireAdminAuth` (ADMIN only):**
- `app/api/admin/maintenance/route.ts` + `/preflight` — toggles site-wide maintenance mode
- `app/api/admin/system-jobs/run/route.ts` — triggers cron jobs manually
- `app/api/admin/newsletter/send/route.ts` — sends mass email
- `app/api/admin/payouts/process/route.ts` — releases real money to consultants
- `app/api/admin/exchange-rates/route.ts` (POST) — invalidates FX cache
- `app/api/admin/tds/route.ts` (POST only) — files Form 26Q with the income tax department (permanent compliance record; the GET handler for `view=form26q` which exposes decrypted PAN is also gated to strict ADMIN inline)

**`requirePrivilegedAuth` (ADMIN + STAFF):** everything else.

Both local `requireAdmin()` helpers (`admin/maintenance/route.ts`, `admin/exchange-rates/route.ts`) are replaced with thin wrappers around `requireAdminAuth()` that preserve their existing `{ userId }` return shape.

## Consequences

### Positive

- **Schema is ~25 lines simpler.** One less enum, one less field, one less index, one less type the rest of the code carries.
- **Every admin/staff route is 15–20 lines shorter.** Auth is one function call, not an 8-line block.
- **Consistency.** There's exactly one place to change the privileged-role logic (the helper). Previously a change would require sweeping ~46 files.
- **Tightened access on 6 routes.** `payouts/process`, `exchange-rates` (POST), `newsletter/send`, `maintenance/*`, `system-jobs/run`, and `maintenance/preflight` were previously accepting STAFF in the inline check. They are now strict ADMIN-only, matching the intent of the operations.
- **Clearer mental model.** Reviewers can immediately tell whether a route is ADMIN-only or PRIVILEGED by reading one line.

### Negative

- **Six routes (listed above) newly reject STAFF.** If anyone was using a STAFF account to trigger payouts processing or maintenance mode, they now get 403. This is a deliberate tightening, not a regression. The bus factor on those operations was already 1 (only the founding ADMIN did them in practice).
- **Behavioral test coverage for admin routes is weak** — we don't have E2E tests that exercise "STAFF user tries to call admin route, gets 403." The refactor is visually verified by grep and manual smoke tests. Follow-up: add a small test suite that exercises each helper once.
- **`AdminProfile` row loses the `adminLevel` column.** The column is dropped, not deprecated. Any out-of-band database tooling that queried it will break. Pre-MVP this is fine — we have no production data.

### Neutral

- The `customConsultantPayoutRate`, `assignedRegions`, and other `AdminProfile` fields referenced in #326's roadmap are not touched. `accessScope` JSON and `assignedRegions` never existed in the actual schema despite being mentioned in the issue — the issue body described an aspirational future state, not the reality.

## Alternatives considered

1. **Keep `AdminLevel` and implement the permission matrix now.** Rejected: zero current usage, no customer demand, and the implementation would be wasted effort if the post-MVP decision is to go with a proper role/permission table instead.
2. **Simplify to 2 levels (`ADMIN`, `MODERATOR`) and map to the existing `UserRole.ADMIN` and `UserRole.STAFF`.** Rejected: adds complexity (a third concept alongside `UserRole`) without solving a real problem. `UserRole` already distinguishes ADMIN from STAFF.
3. **Implement helpers without dropping `AdminLevel`.** Rejected: the column stays dead, continues to drift, and every new admin feature has to decide whether to consult it. Drop now or drop never.

## Migration

Schema change: `ALTER TABLE "AdminProfile" DROP COLUMN "adminLevel"; DROP TYPE "AdminLevel";`

This will be applied as part of the PR's migration SQL when the Supabase dev DB is reseeded (the user's workflow — mock data is dropped and regenerated at PR merge time).

## Follow-ups

- **Extract more shared operator utilities** into `lib/api/operators/` — payments, invoices, verification queue, disputes, feedback, tickets. The pattern is established with `stats.ts` in this PR. Tracked in #646 (enterprise follow-ups).
- **Add automated tests** for the auth helpers and for ADMIN vs STAFF access on a representative sample of routes. Small, targeted test suite, not comprehensive coverage.
- **Close #326** once this PR merges.

## References

- `lib/auth-helpers.ts` — new helpers
- `docs/api/auth-helpers.md` — quick reference for route authors
- `lib/api/operators/stats.ts` — first example of the shared-utility pattern
- #326 — the issue being closed
