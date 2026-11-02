# Dashboard information architecture: glossary and current navigation trees

This page records the words the dashboards use for their pages and the navigation trees as the builders in `lib/dashboard/nav/` produce them today. It exists because the same word used to mean different things depending on the role: "Recordings" named sessions you hosted in one dashboard and sessions you attended in another, and "Requests" named booking requests, organization allocation requests or support requests. The rule is one word, one meaning. Permission gating is never changed by a rename or a regrouping; the permission matrices in `lib/auth/org-permissions.ts` and `lib/backoffice/capability.ts` stay the single source of truth.

## Glossary

| Term                            | Means                                                                               | Not to be confused with                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Recordings (in Studio)          | Recordings of sessions you hosted, which you can rename, delete or sell as a replay | Session recordings in Library                                              |
| Session recordings (in Library) | Recordings of sessions you attended (in an organization, also sessions you deliver) | Replays                                                                    |
| Replays                         | A recording listed for sale, which is a product                                     | Raw recordings                                                             |
| Digital products                | Files sold or given away, such as e-books, templates and packs                      | Plan materials                                                             |
| Session documents               | Files exchanged in one specific booking                                             | Plan materials, which are files attached to a plan for its buyers          |
| Billing                         | What you pay, as a learner or as an organization sponsor                            | Earnings, which is what you are paid                                       |
| Booking requests                | Clients asking to book you                                                          | Support cases                                                              |
| Support cases                   | The conversations a person opens with the support team                              | Booking requests                                                           |
| Library                         | Only the buyer's or attendee's library                                              | The organization Catalog, whose icon is `LayoutGrid` rather than `Library` |

The consultant dashboard still keeps "Session documents" and "Recordings" (the sessions the expert hosted) in a group labelled Library until they move to Studio; "My library" is the expert's buyer Library.

## Current navigation trees

Each tree is built by a pure function, so the groups below are what the sidebar renders for a viewer who passes every gate. The breadcrumb labels in each file's `*_PAGE_LABELS` map match the item names.

### Consultant (`buildConsultantNav`)

- Work: Home, Booking requests, Appointments, Messages
- Business: Offerings, Availability, Reviews
- Money: Earnings & payouts
- Library: Session documents, Recordings (hosted sessions)
- Grow: Invite & earn
- My library (its own top-level item)
- Operations: Help & support, Settings
- Pinned: View public page. Mobile tabs: Home, Requests, Appointments, Messages.

### Consultee (`buildConsulteeNav`)

- Home, Appointments, Messages, Library
- Money: Billing, Invite & earn
- Operations: Help & support, Settings
- Pinned: Find experts. Mobile tabs: Home, Appointments, Library, Messages. Billing opens from the Menu sheet, and the "Needs you" card stays on Home.

### Organization (`buildOrganizationNav`)

Items appear only when the viewer's role and the organization's capabilities pass the same gates the pages check.

- Top: Overview, My Program, Compensation, Appointments, Messages, Booking requests, Plan collaborators
- Library (one unlabelled item, so the group does not restate it)
- People: Members
- Sponsorship: Programs, Contracts
- Hosting: Catalog (icon `LayoutGrid`)
- Money: Billing, Payouts
- Operations: Help & support
- Insights: Analytics, Audit, Consent

Organization settings is not a rail item. It opens from the avatar menu and from the mobile Menu sheet, which lists the row only for an ACTIVE membership whose role passes `canOpenOrgSettings`. A suspended member sees Overview, Appointments and Library only.

### Workspace (`buildWorkspaceNav`)

- Overview, plus Activity and Spend when the person owns more than one organization
- Operations: Help & support, Workspace settings

## Library

Library means only what the viewer bought, attended or was given access to. One server component, `LibraryPage` in `components/dashboard/library/LibraryPage.tsx`, renders it for every role. Its tabs live in the URL as `?tab=purchases|recordings|documents`, parsed through the `LibraryTabSchema` enum in `lib/dashboard/library-tabs.ts`. An unknown or unavailable tab opens the viewer's first tab. Each tab is a link, so switching tabs is a server navigation and the server reads only the active tab's data:

- Purchases lists `readDigitalProductLibrary()` for the buyer's user id through `DigitalProductLibrary`.
- Session recordings and Session documents seed page 1 of `readRecordingLibrary()` or `readDocumentLibrary()` and hand over to `PersonalLibrary` (learner side) or `OrgLibrary` (organization), which fetch filtered pages on the client.

| Role         | Route                                     | Title      | Tabs                                                                                                                               |
| ------------ | ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Learner      | `/dashboard/consultee/<id>/library`       | Library    | Purchases, Session recordings, Session documents                                                                                   |
| Expert       | `/dashboard/consultant/<id>/library`      | My library | Purchases, plus Session recordings and Session documents only when the owner also has a learner profile; one tab hides the tab bar |
| Organization | `/dashboard/organization/<orgId>/library` | Library    | Session documents, Session recordings, each keeping the Mine and Everyone scope (`?scope=`)                                        |

An expert's attended sessions belong to their learner profile, so the expert's recordings and documents tabs read and link to the learner side (`/dashboard/consultee/<learner id>/…`). The organization Library keeps its gates: every member, a suspended one included, reads Mine (`requireOrgAccess` with `allowSuspended`), and Everyone needs an active member with `operations.read` (`libraryScopeFor()`).

The account menu on every surface carries **My library**, which links to `/dashboard/go/library`. `resolveGoHref()` in `lib/dashboard/go.ts` sends a viewer with a learner profile to the learner Library, a viewer with only an expert profile to My library, and anyone else (an organization workspace operator, for example) to `/dashboard`. The go page forwards `?tab=`, so digital product receipts, the product page's "Open library" and "Back to library" links and the purchase email all use `/dashboard/go/library?tab=purchases` (`digitalProductLibraryHref()`); the email makes it absolute. Find lists My library under Account and matches it, and the Library rail items, on "purchases", "products", "recordings", "documents" and "downloads".

## Public pages

The public site follows the same words as the dashboards.

- **Expert profile.** `/explore/experts/<id>` is one scrolling page with a sticky tab bar (`ProfileAnchorTabs`): About, Sessions, Programs, Products & replays and Reviews. Each tab links to a section id (`#about`, `#sessions`, `#programs`, `#products`, `#reviews`). A tab is hidden when its section is empty (no 1:1 or subscription plans, no classes or webinars, no digital products, no reviews), and the bar disappears when only About is left. An `IntersectionObserver` marks the section being read with `aria-current`; the tabs are plain links, so the keyboard and a no-script visit work, and on a narrow screen the bar scrolls sideways. The page's data reads did not change.
- **Products index.** `/explore/products` has two tabs in the URL, `?tab=products|replays`, parsed through `ProductsTabSchema` in `lib/explore/products-tabs.ts` (anything else opens Digital products). Digital products lists `listPublicDigitalProducts()` (`lib/data/digital-products-public.ts`): the same `digitalProductDiscoverableWhere()` visibility as the product page, newest first, 48 at most, cached for 300 seconds under the `digital-products` tag. `purgeDigitalProductSurfaces()` clears it on publish, edit, archive, moderator takedown and, after commit, on a creator's erasure (which archives their products); `purgeExpertSurfaces()` clears it too, because cards carry the creator's name, so a profile name or avatar change refreshes them. Cards show the amount before GST with a "+ GST" label (`productPriceLabel()`), the same as the expert profile; free products show "Free". Replays renders the grid the old Recordings Library showed from `listPublicReplayCards()`, cached the same way under the `recordings` tag that `purgeRecordingSurfaces()` clears on unpublish, on a hosted recording's removal and after an erasure unpublishes a host's replays. The page sits in an `(index)` route group beside `[slug]`, so its `loading.tsx` stays out of the detail pages' ancestors.
- **Breadcrumbs.** Product, replay and the four plan detail pages show Experts › Expert name › Item title through `PublicBreadcrumb` (`components/explore/PublicBreadcrumb.tsx`); a plan with no consultant drops the middle crumb.
- **Account menu.** The signed-in avatar in the public header opens a menu. The first time it opens (the mobile sheet counts as opening it), `useDashboardFacets()` fetches `GET /api/user/dashboard-facets` and keeps the answer for the session, keyed by user id so signing in or out refetches. The route runs `resolveDashboardFacets()` with the same inputs as the dashboard ContextSwitcher: the session's profile ids and role, plus every non-deactivated membership (`findSwitcherMemberships()`, shared with `/api/user/org-memberships?all=1`). It answers 401 signed out, `Cache-Control: private, no-store`, and only each facet's kind, key, label and href (`DashboardFacetsResponseSchema`), so the menu lists Expert, Learner (only once a learner profile exists), every organization, All organizations, Admin and Staff exactly as the switcher does. While loading, the menu shows one door per personal profile the session holds plus a skeleton row; if the fetch fails it shows those doors and "All dashboards" (`/dashboard`). My library (`/dashboard/go/library`), Settings (`accountSettingsHref()`) and Sign out are always there, and the mobile sheet lists the same rows. The route is not rate-limited, like `/api/user/org-memberships`, and reads no client IP.

## Legacy redirects

Every moved route answers a `permanentRedirect` (308) that keeps the old query and drops any stale `tab`. The personal routes are recorded in `lib/dashboard/personal-legacy-routes.ts` and the organization routes in `ORG_TAB_REDIRECTS` (`lib/dashboard/org-tab-redirect.ts`).

| Old route                                    | New route                                                |
| -------------------------------------------- | -------------------------------------------------------- |
| `/dashboard/consultee/<id>/products`         | `/dashboard/consultee/<id>/library?tab=purchases`        |
| `/dashboard/consultee/<id>/recordings`       | `/dashboard/consultee/<id>/library?tab=recordings`       |
| `/dashboard/consultee/<id>/documents`        | `/dashboard/consultee/<id>/library?tab=documents`        |
| `/dashboard/consultant/<id>/purchases`       | `/dashboard/consultant/<id>/library`                     |
| `/dashboard/organization/<orgId>/documents`  | `/dashboard/organization/<orgId>/library?tab=documents`  |
| `/dashboard/organization/<orgId>/recordings` | `/dashboard/organization/<orgId>/library?tab=recordings` |
| `/explore/recordings` (the index only)       | `/explore/products?tab=replays`                          |

The per-booking pages (`appointments/<id>/documents` and `appointments/<id>/recordings`) did not move, and neither did the expert's hosted Recordings and Session documents pages.

## Support wording

The support area is called Support cases wherever the viewer sees it: the first tab of Help & support, the breadcrumb, the case back link and the organization and workspace support page titles. The header Help menu has a personal row that links to the viewer's own cases page. Inside an organization that row reads "My support cases", so it is not mistaken for the organization's triage page behind the sidebar's Help & support; everywhere else it reads "Support cases". Booking "Requests" keeps its name. Find still matches the old words "recordings" and "support requests" through synonyms in `lib/dashboard/nav/find-index.ts`.

## Planned phases

1. Glossary and labels: renames only, no route moves (done).
2. A shared buyer Library with Purchases, Session recordings and Session documents for every role that can buy (this page describes the result).
3. A consultant Studio group holding the hosted Recordings and Session documents, and the Sell grouping of offerings into sessions, group programs and products.
4. The organization regrouping into My work, Sponsor and Host, with Billing and Payouts tabs merged to at most three visible plus a "More" menu.
5. Public pages: expert profile anchor tabs, a products index with replays, breadcrumbs and a public header account menu (done; see Public pages).

## Deprecated & Superseded Approaches

The organization rail used to carry its own "Organization settings" item under Operations, duplicating the avatar menu entry. It was removed, and the mobile Menu sheet no longer skips the settings row when a rail item points at the same page. Do not add the item back.

The support area used to be called "Support requests", with a first tab labelled "Requests". Both are now "Support cases", and "Requests" is reserved for booking requests. The component `SupportRequestView` and the `requestsHref` property keep their old identifiers; only the words the viewer reads changed.

The Catalog item used the `Library` icon, which collided with the learner's Library group. It now uses `LayoutGrid`.

The expert's temporary "My purchases" item (`/dashboard/consultant/<id>/purchases`), the learner's Library group with Session documents, Session recordings and Digital products (`documents`, `recordings` and `products`), and the organization's two Library items (`documents` and `recordings`, with `OrgLibraryPage` rendering each) were replaced by the one Library page per role. The old URLs only redirect now; do not link to them or add pages under them.

The public "Recordings Library" at `/explore/recordings` was folded into the Replays tab of `/explore/products`. The index only redirects (308, query kept); `/explore/recordings/<slug>` still serves a replay. Do not link to the old index or add a page back there. The avatar used to be a plain link to Settings with a separate Sign out button; do not restore it.
