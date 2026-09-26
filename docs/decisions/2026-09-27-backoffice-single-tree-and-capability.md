# ADR: One back-office route tree, with a capability context replacing role props

- **Status**: Accepted
- **Date**: 2026-09-27
- **Part of**: #1527, PR #1842

## Context

The admin and staff dashboards lived in two separate URL trees, `app/dashboard/admin/**` and `app/dashboard/staff/[staffId]/**`. The `[staffId]` segment in the staff tree's URLs did nothing — it was never read to scope a query or a permission — so it existed only as an artefact of an earlier design. Thirteen of staff's pages were near-duplicates of an admin page, `isAdmin` and `canManage` boolean props were threaded through roughly 26 files to express what should have been one capability decision, and about 24 `/api/staff/**` routes existed alongside their admin equivalents, even though only two of them (`/api/staff/payouts`, `/api/staff/moderation/profiles[/:id]`) actually served identical data to an identical shape. A #1527 decision (item 13) had called for merging admin and staff into one route tree with a capability context, but by the time this PR started, only the chrome had been shared (PR #1812/#1841); the two URL trees, the `[staffId]` segment and the API duplication were all still in place.

Separately, the back office had accumulated real defects that a route merge would need to carry forward correctly rather than lose: four payout statuses (APPROVED, FAILED, CANCELLED, REVERSED) appeared on no tab at all; "Approval Payments" pointed staff and admins at a system that PR #1824 had already superseded with in-place appointment state; and two separate verification queues existed (one under Moderation, one under Users) doing the same job.

## Decision

### The tree

The back office is now one route tree, `app/dashboard/(backoffice)/[tree]/**`, where `[tree]` is the literal path segment `admin` or `staff` — not a profile id. The tree's layout calls `notFound()` for any value of `[tree]` other than those two, before any role check runs, so the route space itself cannot be walked into anything else.

### The capability model

`lib/backoffice/capability.ts` is the single source of truth for what a signed-in operator may see and do inside this tree:

- `resolveBackofficeCapability(role, tree)` returns `null` when the role may not open the requested tree at all — a non-operator, or a STAFF role requesting the `admin` tree — and otherwise returns a `BackofficeCapability` carrying the tree, its `basePath` (`/dashboard/<tree>`), the viewer's own role, and the tree's `audience` (`ADMIN` for the admin tree, `STAFF` for the staff tree).
- `can(cap, surface)` requires **both** `hasBackofficePermission(cap.audience, surface)` and `hasBackofficePermission(cap.role, surface)` to be true. This is deliberate: the tree segment controls what that _console_ is allowed to show at all, and the viewer's own role caps it further, so an admin who opens the staff tree sees exactly what a staff member would see there — never more, because the tree's audience is STAFF regardless of who is looking at it.
- `BackofficeCapabilityProvider` exposes the same `BackofficeCapability` to client components through `useBackofficeCapability()`, which is what replaced the `isAdmin`/`canManage`/`basePath` props previously passed down through roughly 26 files by hand.
- `backofficeLandingHref(cap)` encodes owner decision Q12: admins land on "Needs attention" (`/dashboard/admin/home`), and staff land on their Tickets queue (`/dashboard/staff/tickets`).

### Legacy URLs

Every retired back-office URL still resolves. `lib/backoffice/legacy-routes.ts` is a pure function, `legacyBackofficeHref(tree, segments, searchParams)`, jest-pinned so its mapping cannot silently drift:

- The old `/dashboard/staff/<uuid>/...` shape (where the UUID was the caller's own `StaffProfile.id` and carried no information) strips the id and re-resolves the remaining segments.
- `approval-payments` now redirects to the Appointments tree with `?tab=awaiting-payment` (owner decision Q9 — the underlying data is appointment state, not a separate system).
- `documents` redirects to Verification with `?tab=documents`; `data-breaches` redirects to Compliance with `?tab=breaches`; `admin/feedbacks` (a plural that never had its own page) redirects to `feedback`.
- Every mapped redirect carries the incoming query string forward, and appends any override the mapping itself needs (such as the `tab` value).

A catch-all page at `[tree]/[...legacy]/page.tsx` calls this function: a resolved href becomes a 308, and `null` becomes a 404. Only the two genuinely duplicate API routes named above were deleted outright; the remaining `/api/staff/**` routes were kept, because — unlike the page routes — they return data shapes specific to what staff need, not a copy of the admin response.

### API surface

The two API namespaces (`/api/admin/**` and `/api/staff/**`) were kept as-is beyond the two duplicate deletions. This ADR does not collapse them, because the #1527 decision that proposed a single shared API set for both audiences was re-validated during this PR's planning and found to not hold: most `/api/staff/**` routes exist because staff-facing reads are genuinely narrower (fewer fields, different filters) than their admin equivalents, not because they were copy-pasted.

## Consequences

### Positive

- The old `[staffId]` URL segment, which had never done anything, is gone, along with roughly 21 duplicate `loading.tsx` files that existed once per tree.
- A single capability object, rather than a chain of boolean props, decides what renders on both server pages (`requireBackofficePage`, now tree-aware) and client components.
- Every previously bookmarked or emailed back-office URL still works, because the legacy-routes mapping is exhaustive by construction (jest-pinned) rather than best-effort.

### Negative

- The `admin/**` → `(backoffice)/[tree]/**` move is large by file count (this ADR's PR moved roughly 47 files in the back-office tree alone) even though Sonar reads it as pure renames, because it was done as one `git mv` commit ahead of the functional changes.
- Two verification queues were merged into one Verification destination and Approval Payments was retired as a concept in favour of an Appointments tab; anyone who had the old URLs memorised (rather than following a link) needs the redirect to fire correctly, which is why the legacy-routes mapping is tested rather than assumed.

## References

- #1527 decision 13 — the original "merge admin and staff, keep two true API twins" call this ADR fulfils.
- PR #1842 — the implementation.
- `lib/auth/backoffice-permissions.ts` — the underlying `BackofficeSurface` permission table that `can()` reads from.
- `docs/decisions/2026-09-27-org-role-matrix.md` — the equivalent capability-matrix approach applied to the organization dashboard.
