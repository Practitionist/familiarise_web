# ADR: Dashboard IA moves delete the old URLs instead of redirecting

- **Status**: Accepted on 2026-11-03 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-03
- **Author**: Platform engineering
- **Related**: [Dashboard information architecture](../dashboard/information-architecture.md), [Personal vs org dashboard split](../enterprise/70-design-decisions/19-personal-vs-org-dashboard-split.md), issue #2539

## Context

The #2539 dashboard restructure moved pages into Library, Sell and merged org tabs. Its fifth principle said every moved route would answer a `permanentRedirect` (308) that keeps the old query, and the first six phases added a redirect page, a legacy map and a test for each. The product is pre-launch: no external user holds a bookmark, and any link in a sent email or notification can be repointed in the same change.

## Decision

Delete the redirect stubs and make every internal reference name the new URL. The old URLs answer 404. Unknown `?tab=` values are not rewritten; each page's `z.enum` parse falls back to its default tab.

Deleted:

- Consultee `products`, `recordings`, `documents`, `resources`, `help` and `feedback`.
- Consultant `purchases`, `planner`, the Offerings list (`offerings`, `offerings/products`, `offerings/collaborations`), `help`, `feedback` and `settings/security`. The editors under `offerings/[type]/…` stay. The `settings?tab=` aliases are dropped as well, but `settings` is still a live page that ignores `?tab=`, so an old tab link opens the Settings hub instead of a 404.
- Organization `documents`, `recordings`, `purchase-orders`, `reimbursements`, `disputes` and `materials`, and the retired `?tab=` values of Billing, Payouts and Catalog.
- The `/explore/recordings` index. `/explore/recordings/[slug]` stays.
- `lib/dashboard/personal-legacy-routes.ts` and `lib/dashboard/org-tab-redirect.ts`, with the tests that pinned them.

## Why

AGENTS.md section 1.2 says to delete dead code outright and keep no back-compat shims for internal callers. With no external users the redirects protect nobody, and each one is a page, a map entry and a test to keep in step with the real routes.

## Consequences

- A stale bookmark or an old deep link 404s. This is accepted before launch; a post-launch move of the same kind needs redirects again and a new record.
- Recording and document notifications now link to the Library tab (`library?tab=recordings` or `library?tab=documents`) through `lib/novu/resolve-href.ts`.
- `/dashboard/go/…` no longer lists `planner` or `resources`; `payments` stays because that page exists, and `offerings` stays for the editors under `offerings/[type]/…`.

## Follow-up (2026-11-03)

A second pull request removed the remaining legacy redirects on the same reasoning:

- The back-office catch-all `[tree]/[...legacy]/page.tsx` and `lib/backoffice/legacy-routes.ts`, with their tests. The retired URLs `payments`, `refunds`, `payouts`, `disputes`, `approval-payments`, `documents`, `feedbacks`, `data-breaches` and the old `staff/<StaffProfile id>/…` prefix now answer 404. The payment and dispute detail pages stay. `staffTwinHref` is not a legacy redirect (it sends STAFF who open an admin URL to the same page in their tree), so it moved to `lib/backoffice/capability.ts`.
- The four orphaned index `loading.tsx` files under `[tree]/payments`, `disputes`, `payouts` and `refunds`, and `retiredMoneyTabHref` (the `/money/class-series` 308).
- The global `/profile` page and layout. Links that pointed at it now use `accountSettingsHref` or `dataConsentHref` where the viewer is known, and `/dashboard` (which lands each viewer on their own dashboard) where it is not: the email footer, the unsubscribe page and the account-menu fallback. The checkout consent toast now links straight to Settings › Account.
- The consultant `/settings/payouts` 308 in `middleware.ts`; the section lives at `/settings/get-paid`.
- The org Members `?tab=all|learners|experts` aliases. The page reads `tab` through a `z.enum(["members", "invitations"])` with a `members` fallback.

Kept, because they do real work: `/dashboard/support/[caseKey]` (authorizes the case, then resolves the viewer's own case page) and `/dashboard/evidence/[requestId]` (looks up the evidence request, checks attachment access, then resolves the viewer's inbox). Notifications and emails link to these two role-neutral URLs. `/settings/change-password` is also a redirect-only page that was not in this pull request's list and remains.
