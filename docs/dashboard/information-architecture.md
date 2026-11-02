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

In the consultant dashboard, Studio holds what the expert made in sessions (Recordings and Session documents), Sell holds what the expert offers, and "My library" is the expert's buyer Library.

## Current navigation trees

Each tree is built by a pure function, so the groups below are what the sidebar renders for a viewer who passes every gate. The breadcrumb labels in each file's `*_PAGE_LABELS` map match the item names.

### Consultant (`buildConsultantNav`)

- Today (path `home`)
- Inbox: Booking requests (badge), Messages (badge)
- Calendar: Appointments, Availability
- Sell: 1:1 & subscriptions (`sell/sessions`), Group programs (`sell/programs`), Products (`sell/products`), Collaborations (`collaborations`)
- Studio: Recordings (hosted sessions, `recordings`), Session documents (`documents`)
- Money: Earnings & payouts
- Reputation & growth: Reviews, Invite & earn
- My library (its own top-level item)
- Settings & help: Help & support, Settings
- Pinned: View public page. Mobile tabs: Today, Requests, Appointments, Messages.

### Consultee (`buildConsulteeNav`)

- Home, Appointments, Messages, Library
- Money: Billing, Invite & earn
- Operations: Help & support, Settings
- Pinned: Find experts. Mobile tabs: Home, Appointments, Library, Messages. Billing opens from the Menu sheet, and the "Needs you" card stays on Home.

### Organization (`buildOrganizationNav`)

Items appear only when the viewer's role and the organization's capabilities pass the same gates the pages check. The regrouping moved items between groups without changing any gate.

| Group          | Items and their gates                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Every member                                                                                                                                                                                                                                   |
| My work        | My Program (`myProgram.read` and `canSponsor`), Compensation (`myArrangement.read` and `canHost`), Appointments (every member), Booking requests (a consultant profile and `canHost`), Plan collaborators (`myArrangement.read` and `canHost`) |
| Messages       | Every member                                                                                                                                                                                                                                   |
| Library        | Every member, one unlabelled item so the group does not restate it                                                                                                                                                                             |
| People         | Members (`members.directory`)                                                                                                                                                                                                                  |
| Sponsor        | Programs (`programs.read`), Contracts (`contracts.read`), Billing (`billing.read`), each also needing `canSponsor`                                                                                                                             |
| Host           | Catalog (`catalog.manage`, icon `LayoutGrid`), Collaborators (`catalog.manage`), Payouts (`payouts.read`), each also needing `canHost`                                                                                                         |
| Insights       | Analytics (`operations.read`), Audit (`audit.read`), Consent (`consent.read`)                                                                                                                                                                  |
| Help & support | Every member; the page is the organization's triage, and each of its tabs carries its own gate                                                                                                                                                 |

My work has five items, one more than the usual limit of about four, because every item in it is gated and most members see two or three of them. A learner on a sponsoring organization sees My Program and Appointments; an expert on a hosting organization sees Compensation, Appointments and Plan collaborators, plus Booking requests with a consultant profile.

Plan collaborators (`collaborations`) and Collaborators (`collaborators`) are two pages over the same `InvitationsPanel`. Plan collaborators is an expert's own plans and invitations, and its page admits anyone who delivers for the organization (`deliversForOrg`). Collaborators is every plan the organization hosts, whoever delivers it, read-only, behind Catalog's gate. No current role holds both `catalog.manage` and `myArrangement.read`, so nobody sees both items.

The phone tabs did not change: operators get Overview, Appointments, Members and Billing or Payouts, and members get their own landing page, Appointments and Messages (`organizationMobileTabs`). `__tests__/dashboard/org-nav-gates.test.ts` snapshots the visible item set and phone tabs for every role, capability, suspension and consultant-profile combination (112 in all); the only difference since the regrouping is the Collaborators item, which appears exactly where Catalog does.

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

The account menu on every surface carries **My library**, which links to `/dashboard/go/library`. `resolveGoHref()` in `lib/dashboard/go.ts` sends a viewer with a learner profile to the learner Library, a viewer with only an expert profile to My library, and anyone else (an organization workspace operator, for example) to `/dashboard`. The go page forwards `?tab=`, so digital product receipts, the product page's "Open library" and "Back to library" links and the purchase email all use `/dashboard/go/library?tab=purchases` (`digitalProductLibraryHref()`); the email makes it absolute. Find matches the Library rail items on "purchases", "products", "recordings", "documents", "downloads", "ebooks" and "templates". In a personal tree that already has a Library item, Find skips the account menu's My library row, so a learner sees one Library entry; elsewhere it lists My library under Account. The Sell pages also match "offerings".

## Sell

Sell is everything the expert offers. Each list page renders through `SellPageShell` (`components/offerings/list/SellPageShell.tsx`): a header with the **+ New** picker, `?tab=` links that navigate, and the active tab's list. The tab enums live in `SELL_TAB_SCHEMAS` (`lib/dashboard/sell-pages.ts`); an unknown or missing `tab` opens the first tab, and no page has more than three tabs.

| Page                | Route                                       | Tabs                         | List                                                                 |
| ------------------- | ------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| 1:1 & subscriptions | `/dashboard/consultant/<id>/sell/sessions`  | Consultations, Subscriptions | `EventManagementDashboard` for one plan kind                         |
| Group programs      | `/dashboard/consultant/<id>/sell/programs`  | Webinars, Classes            | `EventManagementDashboard` over the planner read                     |
| Products            | `/dashboard/consultant/<id>/sell/products`  | Digital products, Replays    | `DigitalProductList`, or `HostedReplays` over `listHostedReplays()`  |
| Collaborations      | `/dashboard/consultant/<id>/collaborations` | none                         | `InvitationsPanel`: invitations to co-host and the plans you co-host |

`SellOfferingsList` passes `EventManagementDashboard` one plan kind. The 1:1 tabs read only their own plan list and skip the planner read; the webinar and class tabs read the planner, which carries the group instances. The search box stays in the URL as `?q=`.

Replay sales are closed, so there is no listing editor. The Replays tab lists the expert's own recordings whose `listingStatus` is `PUBLISHED`, read on the server after `requirePersonalProfileAccess()`, and otherwise shows an empty state that links to Studio › Recordings. The Studio Recordings page carries a **Sell as replay** link to `sell/products?tab=replays`.

The **+ New** picker (`NewOfferingMenu`) offers 1:1 consultation, subscription, webinar, class and digital product. Each opens the existing editor at `offerings/<kind>/new`; editing stays at `offerings/<kind>/<id>/edit`. After a save the editors return to the Sell page and tab that lists that kind (`sellHomeHref()`), and an editor's `offerings` and `<kind>` breadcrumbs open that list too (`sellHomePath()`).

## Organization page tabs

No organization page shows more than three tabs. Billing and Payouts render through `TabsWithOverflow` (`components/dashboard/shared/TabsWithOverflow.tsx`), which keeps the active tab in `?tab=` like `UrlTabs`, shows the first three tabs the viewer can see, and lists the rest in a **More** menu beside the tab list. The menu is a Radix dropdown, so it opens with Enter, Space or the arrow keys and closes with Escape. A tab chosen from the menu, or opened by its `?tab=` link, takes the last inline slot and the tab it displaces moves into the menu, so the open panel always has a real, selected tab that labels it, as the WAI-ARIA tabs pattern requires. Each tab keeps its old gate, and a merged tab stacks the old panels, unchanged, one after the other. A stacked section carries an id (`accrued-usage`, `license`, `earnings`, `expert-routing`); when the URL hash names it, `useScrollToHashOnReady()` (`hooks/useScrollToHashOnReady.ts`) scrolls it into view once its panel's data has rendered, once per page load, and jumps instead of animating when the viewer prefers reduced motion.

| Page    | Tab (`?tab=`)                       | What it shows, and when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing | Invoices & usage (`invoices`)       | Invoices, always; then Accrued usage (`#accrued-usage`) when the organization is on INVOICE funding or has accrued postings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Billing | Wallet & licence (`wallet`)         | The wallet on WALLET funding, or the annual licence (`#license`) on LICENSE funding; hidden on the other rails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Billing | Purchase orders (`purchase-orders`) | When the organization requires purchase orders and the viewer holds `purchaseOrders.read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Billing | Payment disputes (`disputes`)       | With `disputes.read`; under More when three tabs are already showing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Billing | Member spend (`member-spend`)       | On PERSONAL funding with `reimbursements.read`; under More when three tabs are already showing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Payouts | Runs & earnings (`runs`)            | Payout runs, then Earnings (`#earnings`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Payouts | Payout account (`payout-account`)   | The bank account; only `payouts.account.manage` edits it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Payouts | Rate cards & routing (`rate-cards`) | Rate cards, then Expert routing (`#expert-routing`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Catalog | Webinars, Classes, Materials        | Webinars and Classes list live plans with status chips (All statuses, Published, Drafts) and an Archived chip once something has been withdrawn; `?status=archived` opens on that chip in the first kind with archived plans (Classes when only classes are withdrawn) and, with nothing withdrawn, shows "No archived …" rather than live plans. The Archived chip writes `?status=archived` and the lists read it on every render, so back, forward and links into or out of the archived view always apply. With no experts the lists show "Invite an expert first", and the Archived chip still sits beside it, so withdrawn plans stay reachable |

For example, a WALLET-funded organization that requires purchase orders shows an OWNER Invoices & usage, Wallet & licence and Purchase orders, with Payment disputes under More. An INVOICE-funded organization without purchase orders shows the same OWNER Invoices & usage and Payment disputes, and no More menu.

Every `?tab=` value these pages have ever answered is listed in `ORG_PAGE_TAB_MAP` (`lib/dashboard/org-tab-redirect.ts`). Each page parses `?tab=` through that page's `z.enum` in `orgLegacyTabHref()` and answers a 308 when the value is retired; a current value, a missing one or an unknown one renders the page, which opens its first visible tab.

| Old URL                      | New URL                                 |
| ---------------------------- | --------------------------------------- |
| `billing?tab=accrued-usage`  | `billing?tab=invoices#accrued-usage`    |
| `billing?tab=license`        | `billing?tab=wallet#license`            |
| `payouts?tab=earnings`       | `payouts?tab=runs#earnings`             |
| `payouts?tab=expert-routing` | `payouts?tab=rate-cards#expert-routing` |
| `catalog?tab=archived`       | `catalog?status=archived`               |
| `catalog?tab=collaborators`  | `collaborators`                         |

The old `invoices`, `wallet`, `purchase-orders`, `disputes`, `member-spend`, `runs`, `payout-account`, `rate-cards`, `webinars`, `classes` and `materials` values are current tabs and stay as they are. Billing and payout emails and notifications link to the bare `billing` and `payouts` pages, so they open the first tab. The Overview's "Not yet invoiced" figure links to `billing?tab=invoices#accrued-usage`.

## Legacy redirects

Every moved route answers a `permanentRedirect` (308) that keeps the old query, repeated keys included, and drops any stale `tab`; each redirect page must pass its `searchParams` to the helper. The personal routes are recorded in `lib/dashboard/personal-legacy-routes.ts` and the organization routes in `ORG_TAB_REDIRECTS` (`lib/dashboard/org-tab-redirect.ts`).

| Old route                                             | New route                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `/dashboard/consultee/<id>/products`                  | `/dashboard/consultee/<id>/library?tab=purchases`                      |
| `/dashboard/consultee/<id>/recordings`                | `/dashboard/consultee/<id>/library?tab=recordings`                     |
| `/dashboard/consultee/<id>/documents`                 | `/dashboard/consultee/<id>/library?tab=documents`                      |
| `/dashboard/consultant/<id>/purchases`                | `/dashboard/consultant/<id>/library`                                   |
| `/dashboard/organization/<orgId>/documents`           | `/dashboard/organization/<orgId>/library?tab=documents`                |
| `/dashboard/organization/<orgId>/recordings`          | `/dashboard/organization/<orgId>/library?tab=recordings`               |
| `/dashboard/consultant/<id>/offerings`                | `/dashboard/consultant/<id>/sell/sessions`                             |
| `/dashboard/consultant/<id>/offerings?type=<kind>`    | The kind's Sell page and tab, for example `sell/programs?tab=webinars` |
| `/dashboard/consultant/<id>/offerings/products`       | `/dashboard/consultant/<id>/sell/products`                             |
| `/dashboard/consultant/<id>/offerings/collaborations` | `/dashboard/consultant/<id>/collaborations`                            |
| `/dashboard/consultant/<id>/planner`                  | `/dashboard/consultant/<id>/sell/programs`                             |

The old Offerings list filtered by a `?type=` pill rather than a `tab`, so `offeringsListLegacyHref()` maps `type` to the Sell page and tab and drops it. The editors under `offerings/<kind>/…` are live routes and never redirect; the static `offerings/products` and `offerings/collaborations` redirects take precedence over the dynamic `[type]` segment. The per-booking pages (`appointments/<id>/documents` and `appointments/<id>/recordings`) did not move, and neither did the expert's hosted Recordings and Session documents pages, which only moved into the Studio group. `/dashboard/go/<facet>/sell/…`, `collaborations` and `offerings/…` resolve only to the expert side (`EXPERT_ONLY` in `lib/dashboard/go.ts`).

## Support wording

The support area is called Support cases wherever the viewer sees it: the first tab of Help & support, the breadcrumb, the case back link and the organization and workspace support page titles. The header Help menu has a personal row that links to the viewer's own cases page. Inside an organization that row reads "My support cases", so it is not mistaken for the organization's triage page behind the sidebar's Help & support; everywhere else it reads "Support cases". Booking "Requests" keeps its name. Find still matches the old words "recordings" and "support requests" through synonyms in `lib/dashboard/nav/find-index.ts`.

## Planned phases

1. Glossary and labels: renames only, no route moves (done).
2. A shared buyer Library with Purchases, Session recordings and Session documents for every role that can buy (done).
3. A consultant Studio group holding the hosted Recordings and Session documents, and the Sell grouping of offerings into sessions, group programs and products (done).
4. The organization regrouping into My work, Sponsor and Host, with Billing and Payouts tabs merged to at most three visible plus a "More" menu (done).
5. Public pages: expert profile anchor tabs, a products index with replays, breadcrumbs and a public header account menu.

## Deprecated & Superseded Approaches

The organization rail used to carry its own "Organization settings" item under Operations, duplicating the avatar menu entry. It was removed, and the mobile Menu sheet no longer skips the settings row when a rail item points at the same page. Do not add the item back.

The support area used to be called "Support requests", with a first tab labelled "Requests". Both are now "Support cases", and "Requests" is reserved for booking requests. The component `SupportRequestView` and the `requestsHref` property keep their old identifiers; only the words the viewer reads changed.

The Catalog item used the `Library` icon, which collided with the learner's Library group. It now uses `LayoutGrid`.

The expert's temporary "My purchases" item (`/dashboard/consultant/<id>/purchases`), the learner's Library group with Session documents, Session recordings and Digital products (`documents`, `recordings` and `products`), and the organization's two Library items (`documents` and `recordings`, with `OrgLibraryPage` rendering each) were replaced by the one Library page per role. The old URLs only redirect now; do not link to them or add pages under them.

The consultant's single Offerings item (`offerings`, titled Offerings) held every kind behind a sub-tab bar (`OfferingsTabs`: My offerings, Digital products, Collaborations) and a type pill (All, 1:1, Subscriptions, Webinars, Classes). It was split into the Sell pages and the Collaborations page, and its Business, Library, Grow and Operations groups became Inbox, Calendar, Sell, Studio, Reputation & growth and Settings & help. `/collaborations` used to redirect to Offerings › Collaborations; it is the real page now. The Offerings list URLs only redirect; link to `sell/*` or `collaborations` instead.

The organization rail used to group its items as an unlabelled top group (Overview, My Program, Compensation, Appointments, Messages, Booking requests, Plan collaborators), Library, People, Sponsorship (Programs, Contracts), Hosting (Catalog), Money (Billing, Payouts), Operations (Help & support) and Insights. Those became Overview, My work, Messages, Library, People, Sponsor, Host, Insights and Help & support, with every gate unchanged.

Org Billing used to show up to seven tabs (Invoices, Accrued usage, Wallet, License, Purchase orders, Payment disputes, Member spend), and Payouts showed five (Runs, Earnings, Payout account, Rate cards, Expert routing). They merged into the tabs above. Catalog used to carry Archived and Collaborators tabs; Archived is now a status chip inside the lists, and Collaborators is its own Host item. The retired `?tab=` values only redirect now; do not link to them.
