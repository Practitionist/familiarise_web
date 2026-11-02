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

## Follow-up

The back office (`[tree]/[...legacy]`, `lib/backoffice/legacy-routes.ts`) and the global `/profile`, `/dashboard/support/[caseKey]` and `/dashboard/evidence/[id]` redirects are untouched and go in a separate pull request. The consultant `/settings/payouts` redirect in `middleware.ts` also remains for that pull request.
