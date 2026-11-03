# Consultant dashboard information architecture: the sidebar groups and the Settings hub

**Date:** 2026-09-27 (supersedes the 2026-09-21 version) · **Issue:** #1527 · **PR:** #1842 · **Scope:** `app/dashboard/consultant/[consultantId]/layout.tsx`, `lib/dashboard/nav/consultant.ts`, the `(features)/settings` hub, and the shared `DashboardShell`.

This page records how the consultant (Expert) dashboard is organised after the 2026-09-26/27 dashboard overhaul (PR #1842, part of #1527), and why. It replaces the 2026-09-21 version of this document, which described the sidebar and Settings hub as they stood before that PR. The owner locked "Expert" and "Learner" as the platform's end-user terms during this PR's review rounds; "Consultant" and "Client" no longer appear in the product surface, though the underlying routes, database enums and `consultant`/`consultee` code identifiers are unchanged.

## The shell and the sidebar

The consultant dashboard now shares one `DashboardShell` with every other dashboard tree (personal, organization, workspace and back office), rather than carrying its own chrome. The shell's sidebar begins with the `ContextSwitcher`, which lets a signed-in person move between their Expert dashboard, their Learner dashboard (if they have also bought a session), every organization they belong to, and — for admins and staff — the back office. Below the switcher, the sidebar is a static, unfiltered list of groups, because every surface on a personal dashboard belongs to the one person who owns it. `buildConsultantNav()` in `lib/dashboard/nav/consultant.ts` builds it as:

| Group               | Entries                                                       |
| ------------------- | ------------------------------------------------------------- |
| (none)              | Today                                                         |
| Inbox               | Booking requests (count badge), Messages (unread badge)       |
| Calendar            | Appointments, Availability                                    |
| Sell                | 1:1 & subscriptions, Group programs, Products, Collaborations |
| Studio              | Recordings, Session documents                                 |
| Money               | Earnings & payouts                                            |
| Reputation & growth | Reviews, Invite & earn                                        |
| (none)              | My library                                                    |
| Settings & help     | Help & support, Settings                                      |

Sell splits what the expert offers into `sell/sessions` (Consultations, Subscriptions), `sell/programs` (Webinars, Classes), `sell/products` (Digital products, Replays) and `collaborations`; each has a "+ New" type picker (see [Dashboard information architecture](information-architecture.md#sell)). Offering cards copy the expert's signed personal share link (`?via=<token>` / `?ref=<code>`, locking the 10% own-link platform fee), display subscription cadence and topic/module counts, and hydrate full plan metadata (`deliverables`, `prerequisite`, `material`, `sessionDurationInHours`) in the edit drawer alongside a net take-home preview. Earnings surfaces active `ConsultantFeeWaiver` banners, `Own link (10%)` and `Fee waived` badges on ledger rows, a Tax & TDS (`Form 16A`) quarterly summary with 1-click FY CSV export, and Own-Link vs Marketplace revenue split + repeat learner rate on the Analytics tab. Reviews is a dedicated destination where an expert filters by track (`1:1` vs `Group`) or star rating, replies to learners, reports abusive reviews, and shares sanitised review cards or session milestones to LinkedIn/X. Two rules shape this list: a sidebar entry must be a distinct destination, and a daily work surface is not a preference, which is why Availability stays in Calendar rather than moving into Settings.

Settings & help contains **Help & support** and **Settings** in the sidebar. Help & support has separate pages for Support requests, Evidence requests, Reports & appeals, and Product feedback. Request details retain the dashboard shell and a context panel; the shared secondary menu is hidden on detail routes. Product feedback is separate from support conversations, session ratings, and public Reviews. Settings also remains in the avatar menu as a shortcut. The header Help menu links to the same destinations and the public Help Center. The pinned header action is "View public page".

The mobile tab strip carries four tabs plus **Menu**: Today, Requests, Appointments, Messages. Menu opens a sheet with the switcher, the full nav, Settings and Sign out — Availability, Earnings and everything else not in the four tabs is reached from there, replacing the old five-tab strip that left Messages, the planner and Availability unreachable on a phone.

## Documents and Recordings pages

My library (`library`) is the expert's buyer Library: the shared `LibraryPage` with the Purchases tab (`readDigitalProductLibrary()` keyed by the user), plus Session recordings and Session documents from their learner profile when they have one (see [Dashboard information architecture](information-architecture.md#library)); the old `purchases` URL redirects to it. The Studio group's Recordings and Session documents entries are cross-session indexes, grouped by appointment (`LibraryBrowser`, ten sessions per page), with filters for the learner, kind (All, Consultation, Subscription, Trial and the group kinds), date and search, and for documents "Started by anyone / you / the learner" (plus "Plan materials only") and the status filters "Your turn", a waiting status, "Done" and "Shared" (one rule, `libraryBucket` in `lib/documents/thread-copy.ts`, places a thread under a filter and `libraryChip` gives its row the same words for the viewer's side: "Waiting for review" for a learner, "Waiting for learner" for an expert, both words in mixed or organisation views). Subscription headers read "Started <date> · <n> sessions" and class headers "Your batch <start> – <end> · <n> sessions" ("Batch …" for a host), with cards ordered by latest session and every date in the booking pages' display zone. Documents list one expandable row per document thread (title, "Latest: <name>", a "vN · N versions" chip, Started by, status, Updated and Open latest), sorted needs-you first; expanding it lists the versions newest first, and plan materials sit in their own table. Recordings render one session timeline per booking: a header with the plan, expert, "Open booking" and one retention line, then one row per session (Session, Recording with a state badge, Length, Play) that expands into its parts. The per-row Manage is a link to the booking's Recordings page and appears only on a session that still has a part. When different people removed parts of one session, the line names each of them, for example "Removed by LearnPro Academy and Angela Anderson", without a date. Rows link out; the work happens on two dedicated per-appointment pages reached from the appointment details page, which acts as a hub with snapshot cards for Documents, Materials and Recordings; the Materials card ("Files included with this offering.") lists every file with Open and Download and has no page of its own.

| Page                  | Route                                                                          | Purpose                                                     |
| --------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Documents workspace   | `/dashboard/consultant/[consultantId]/appointments/[appointmentId]/documents`  | Review queue, reply, share a file, status banner per thread |
| Recording details     | `/dashboard/consultant/[consultantId]/appointments/[appointmentId]/recordings` | Sessions, parts, player, manage sheet                       |
| File viewer (new tab) | `/files/documents/[documentId]`, `/files/materials/[materialId]`               | Same-origin viewer that signs on every load                 |

Collaborators and co-hosts see only appointments they are a party to. See [session documents](../documents/README.md#pages-and-routes-per-role) and [recordings](../stream/19-recordings-lifecycle-and-access.md#the-recording-details-page).

## The Availability page

`/dashboard/consultant/[consultantId]/availability` renders `AvailabilitySection` and `AvailabilityGrid` over the same data, and the save contract is the strict whole-profile `PUT /api/user/consultants/[id]`. That logic lives once, in `settings/use-consultant-settings-form.ts`, shared with the Profile and Booking requests settings sections. The retired `settings?tab=availability` deep link still answers a 308 to this page.

## The Settings hub

Settings still renders through the shared `SettingsLayout` primitive (a grouped hub leading to individual full-width forms with a Settings back link, one URL per section), now shared with the consultee, org and back-office trees rather than being consultant-specific. `SETTINGS_SECTIONS` in `settings/settings.ts` reads:

| Group          | Section                | URL                       |
| -------------- | ---------------------- | ------------------------- |
| Account        | Account                | `/settings/account`       |
| Account        | Notifications          | `/settings/notifications` |
| Public profile | Profile                | `/settings/profile`       |
| Public profile | Experience & education | `/settings/experience`    |
| Public profile | Verification           | `/settings/verification`  |
| Business       | Booking requests       | `/settings/booking`       |
| Business       | Get paid               | `/settings/get-paid`      |

Account absorbed `/profile`, `/settings/change-password` and the old Security tab, so a consultant's name, photo, phone, password, active sessions, connected accounts and account deletion live in one place shared with the consultee, workspace, and back-office dashboards. The old Security tab is folded into `account`, and `/profile` no longer exists; `accountSettingsHref` gives each viewer their own Account page (a consultant or consultee their Account section, ADMIN/STAFF the back-office Settings page, ORG_WORKSPACE `/settings/account`). Experience & education lets an expert edit work history and education after onboarding.

The hub root `/settings` shows the grouped section list. The payout section is `/settings/get-paid` (`GetPaidClient.tsx` lives directly inside `settings/get-paid/`); the old `/settings/payouts` URL is gone; `?tab=` is no longer read. A jest pin (`__tests__/dashboards/settings-hub.test.tsx`) asserts that every section has a unique URL.

The consultee (Learner) Settings hub also uses `SettingsLayout`: its sections are Account, Notifications and Learning profile (`CONSULTEE_SETTINGS_SECTIONS` in the consultee tree's own `settings.ts`), following the same one-URL-per-section pattern.

## Where things are

| Concern                                   | File                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sidebar groups, mobile tabs, crumb labels | `lib/dashboard/nav/consultant.ts`, `app/dashboard/consultant/[consultantId]/layout.tsx`                             |
| Shared shell, switcher, header menus      | `components/dashboard/DashboardShell.tsx`, `components/dashboard/ContextSwitcher.tsx`                               |
| Availability page                         | `app/dashboard/consultant/[consultantId]/(features)/availability/page.tsx`                                          |
| Sell pages, share attribution & editor    | `components/offerings/list/SellPageShell.tsx`, `lib/dashboard/sell-pages.ts`, `components/offerings/**`             |
| Earnings, fee waivers, TDS & analytics    | `app/dashboard/consultant/[consultantId]/(features)/earnings/{EarningsBuckets,AnalyticsPanel}.tsx`                  |
| Reviews inbox, filters & share modal      | `app/dashboard/consultant/[consultantId]/(features)/reviews/ReviewsInbox.tsx`                                       |
| Section registry and redirects            | `app/dashboard/consultant/[consultantId]/(features)/settings/settings.ts`                                           |
| Get paid client & section page            | `app/dashboard/consultant/[consultantId]/(features)/settings/get-paid/{page,GetPaidClient}.tsx`                     |
| Hub nav                                   | `components/dashboard/SettingsLayout.tsx`, `app/dashboard/consultant/[consultantId]/(features)/settings/layout.tsx` |
| Shared form state and the combined PUT    | `app/dashboard/consultant/[consultantId]/(features)/settings/use-consultant-settings-form.ts`                       |
| Pins                                      | `__tests__/dashboards/settings-hub.test.tsx`, `__tests__/dashboard/nav-targets-resolve.test.ts`                     |

## Deprecated & Superseded Approaches

- **Flat root-only library rows.** The Documents index listed one row per thread root and hid its versions. Superseded by expandable thread rows with version history (`components/dashboard/library/DocumentTables.tsx`).
- **One Offerings item.** Offerings (`offerings`) held every plan kind, digital products and Collaborations behind a sub-tab bar and a type pill, inside a Business group. Superseded by the Sell pages and the Studio group; the old URLs only redirect.
