# ADR: One `DashboardShell` and one `ContextSwitcher` for every dashboard tree

- **Status**: Accepted
- **Date**: 2026-09-27
- **Part of**: #1527, PR #1842

## Context

Familiarise had four dashboard trees — consultee, consultant, organization and back office — and each one had grown its own shell: `PersonalDashboardShell` for the two personal trees, an inline `OrgDashboardShell` (792 lines) for organizations, an inline shell inside the org-workspace tree, and `OperatorDashboardShell` for admin and staff. Each shell carried its own chrome, canvas colour, gutter spacing and breadcrumb logic, and the app had five separate hand-rolled context menus for switching between them, only one of which (in the workspace and back-office trees) was a real facet switcher, and that one hid itself entirely when the viewer had no organization memberships.

The consequence was concrete, not cosmetic. A consultant who booked a session with another expert had a consultee profile auto-created for them at checkout, because every purchase creates one, but nothing in any shell linked that profile to their consultant dashboard — the two identities were reachable only by typing a different URL. Separately, 37 B2C notification links pointed at a bare `/dashboard`, which redirects by the signed-in user's primary role; a dual-role user following one of those links had roughly even odds of landing on the wrong side of their own account. On mobile, the back-office sidebar never collapsed (a fixed 256px regardless of viewport), the consultee tab bar could not reach Sign out or 6 of its 11 destinations, and the organization tab bar showed only Overview and Settings to LEARNER and EXPERT roles.

## Decision

### One shell

`components/dashboard/DashboardShell.tsx` now renders the chrome for every tree. `PersonalDashboardShell` and the inline chrome of the organization and org-workspace shells are gone. `OrgDashboardShell` and `OperatorDashboardShell` survive only as thin adapters: each builds its tree's nav and account props and hands them to `DashboardShell`. The shell owns the Novu notification provider (previously the organization tree mounted the inbox without a provider at all), the single dashboard error boundary, the `bg-zinc-50` canvas, and the `p-4 sm:p-6 lg:p-8` gutter — all applied identically across every tree. Each tree's layout resolves its own data (nav config, badges, account info) and passes it to the shell as pure props; the shell renders the chrome and does not know which tree it is inside beyond a `kind` discriminator used to key the sidebar's persisted collapse state.

The header, redesigned twice after this PR opened following an owner review of a Cloudflare dashboard screenshot, carries — right to left — the tree's persona call-to-action, a **Help ▾** menu, the notification bell, and an avatar menu holding the signed-in person's name, email, role, a Settings link and Sign out. A standalone sidebar-collapse toggle (bound to Ctrl/⌘ \\) sits to the left of the breadcrumb trail, ahead of everything else in the header.

### One switcher

`components/dashboard/ContextSwitcher.tsx`, evolved from the existing `OrganizationSwitcher`, renders at the top of every sidebar and again inside the mobile Menu sheet, fed by `resolveDashboardFacets()` in `lib/labels/personal-dashboard.ts`. It groups the facets available to the signed-in person as:

- **You**: an Expert facet (if they have a consultant profile) and a Learner facet (if they have a consultee profile) — this is the fix for the dual-role gap above.
- **Organizations**: every membership, including ones in a PENDING or SUSPENDED state, shown with a status badge.
- **Platform**: Admin and Staff facets, shown only to users holding those roles.

The session only carries ACTIVE memberships of ACTIVE organizations, so PENDING and SUSPENDED memberships are fetched lazily from `GET /api/user/org-memberships?all=1` when the switcher opens, rather than widening the session payload on every request. Footer actions ("Create organization", "Become an expert") appear only when the viewer is entitled to them.

### The `/dashboard/go` resolver

Because a single notification payload can be relevant to two different people on two different sides of one record (a consultant and the consultee they are meeting), `app/dashboard/go/[facet]/[[...path]]/page.tsx` and `lib/dashboard/go.ts` resolve a facet-relative link — `expert`, `client`, or `auto` — to the signed-in viewer's own dashboard URL, rather than requiring every caller to already know that viewer's profile id. The `auto` facet is the one that needs a read: for an `appointments/<id>` path it loads that appointment's viewer-side participation (`readAppointmentDetail` plus `appointmentViewerSides`) and routes the caller to whichever personal or organization dashboard they actually have standing in, falling back to their role's own dashboard when the appointment lookup finds no match. `goHref()` gives call sites a typed builder (`goHref("auto", "appointments/123")`) instead of hand-splicing the URL, and the destination page always re-checks access on its own terms, so a wrong resolution here is at worst a benign redirect, not an information exposure.

### Mobile navigation

`MobileNav` shows up to four tabs (configured per tree, each optionally carrying a badge) plus a **Menu** tab. Menu opens a `Sheet` containing the `ContextSwitcher`, the tree's full grouped nav, the header's Help/Settings/Sign-out actions, and the persona CTA. The same component serves every tree, including the back office, whose sidebar is hidden below the `md` breakpoint and now relies entirely on this sheet on a phone.

## Consequences

### Positive

- A dual-role user can now reach both of their dashboards, and every deep link resolves to the correct side without every caller having to look up a profile id first.
- Every tree gets the same mobile navigation guarantee (four tabs plus a full-nav sheet) rather than four different, independently-maintained mobile behaviours.
- Novu, the error boundary, the canvas colour and the gutter are each defined exactly once.

### Negative

- The shell rewrite touched the highest blast-radius files in the dashboard codebase (every existing shell, `PageScaffold`, the nav config for every tree) and was itself redesigned twice after the PR opened as the owner iterated on the header's shape, which is why the PR gained a long tail of commits after it opened.
- `MobileNav`'s four-tab cap means several destinations that used to have their own tab (for example, Earnings on the consultant tree) are now one tap further away, reached through the Menu sheet.
- Role-aware mobile tab sets for organization roles other than the default (BILLING_ADMIN, SUPPORT, EXPERT) were scoped by a dedicated agent but not built in this PR, because the owner prioritised desktop; this is tracked in issue #1845.

## References

- #1527 — the dashboard IA audit this PR closes out.
- PR #1842 — the implementation.
- `docs/dashboard/engineering-log-2026-09-27-dashboard-overhaul.md` — the full account of this PR, including the design-primitive and back-office changes it shipped alongside this shell.
