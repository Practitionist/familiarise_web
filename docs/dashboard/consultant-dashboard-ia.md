# Consultant dashboard information architecture: the sidebar groups and the Settings hub

**Date:** 2026-09-27 (supersedes the 2026-09-21 version) · **Issue:** #1527 · **PR:** #1842 · **Scope:** `app/dashboard/consultant/[consultantId]/layout.tsx`, `lib/dashboard/nav/consultant.ts`, the `(features)/settings` hub, and the shared `DashboardShell`.

This page records how the consultant (Expert) dashboard is organised after the 2026-09-26/27 dashboard overhaul (PR #1842, part of #1527), and why. It replaces the 2026-09-21 version of this document, which described the sidebar and Settings hub as they stood before that PR. The owner locked "Expert" and "Learner" as the platform's end-user terms during this PR's review rounds; "Consultant" and "Client" no longer appear in the product surface, though the underlying routes, database enums and `consultant`/`consultee` code identifiers are unchanged.

## The shell and the sidebar

The consultant dashboard now shares one `DashboardShell` with every other dashboard tree (personal, organization, workspace and back office), rather than carrying its own chrome. The shell's sidebar begins with the `ContextSwitcher`, which lets a signed-in person move between their Expert dashboard, their Learner dashboard (if they have also bought a session), every organization they belong to, and — for admins and staff — the back office. Below the switcher, the sidebar is a static, unfiltered list of groups, because every surface on a personal dashboard belongs to the one person who owns it. `buildConsultantNav()` in `lib/dashboard/nav/consultant.ts` builds it as:

| Group    | Entries                                                             |
| -------- | ------------------------------------------------------------------- |
| Work     | Home, Requests (count badge), Appointments, Messages (unread badge) |
| Business | **Offerings**, Availability, Earnings, **Reviews**                  |
| Library  | Documents, Recordings                                               |
| Grow     | Invite & earn                                                       |

"Offerings" is the renamed Event Planner; the old `planner` route now 308-redirects to `offerings`, and Collaborations moved from its own sidebar entry into an Offerings tab. Offering cards copy the expert's signed personal share link (`?via=<token>` / `?ref=<code>`, locking the 10% own-link platform fee), display subscription cadence and topic/module counts, and hydrate full plan metadata (`deliverables`, `prerequisite`, `material`, `sessionDurationInHours`) in the edit drawer alongside a net take-home preview. Earnings surfaces active `ConsultantFeeWaiver` banners, `Own link (10%)` and `Fee waived` badges on ledger rows, a Tax & TDS (`Form 16A`) quarterly summary with 1-click FY CSV export, and Own-Link vs Marketplace revenue split + repeat learner rate on the Analytics tab. Reviews is a dedicated destination where an expert filters by track (`1:1` vs `Group`) or star rating, replies to learners, reports abusive reviews, and shares sanitised review cards or session milestones to LinkedIn/X. Two rules shape this list: a sidebar entry must be a distinct destination, and a daily work surface is not a preference, which is why Availability stays in Business rather than moving into Settings.

Settings is no longer a sidebar row. It is one entry in the header's avatar menu (name, email, role, Settings, Sign out) alongside a header **Help ▾** menu (Help Center · Support requests · Send feedback) — both are part of the shared `DashboardShell` header, not this tree's own nav. The pinned footer action is "View public page".

The mobile tab strip carries four tabs plus **Menu**: Home, Requests, Appointments, Messages. Menu opens a sheet with the switcher, the full nav, Settings and Sign out — Availability, Earnings and everything else not in the four tabs is reached from there, replacing the old five-tab strip that left Messages, the planner and Availability unreachable on a phone.

## The Availability page

`/dashboard/consultant/[consultantId]/availability` renders `AvailabilitySection` and `AvailabilityGrid` over the same data, and the save contract is the strict whole-profile `PUT /api/user/consultants/[id]`. That logic lives once, in `settings/use-consultant-settings-form.ts`, shared with the Profile and Booking requests settings sections. The retired `settings?tab=availability` deep link still answers a 308 to this page.

## The Settings hub

Settings still renders through the shared `SettingsLayout` primitive (a titled left nav at `md`+, a scrollable segmented strip below it, one URL per section), now shared with the consultee, org and back-office trees rather than being consultant-specific. `SETTINGS_SECTIONS` in `settings/settings.ts` reads:

| Group          | Section                | URL                       |
| -------------- | ---------------------- | ------------------------- |
| Account        | Account                | `/settings/account`       |
| Account        | Notifications          | `/settings/notifications` |
| Public profile | Profile                | `/settings/profile`       |
| Public profile | Experience & education | `/settings/experience`    |
| Public profile | Verification           | `/settings/verification`  |
| Business       | Booking requests       | `/settings/booking`       |
| Business       | Get paid               | `/settings/get-paid`      |

Account absorbed `/profile`, `/settings/change-password` and the old Security tab, so a consultant's name, photo, phone, password, active sessions, connected accounts and account deletion live in one place shared with the consultee, workspace, and back-office dashboards. `SETTINGS_SECTION_ALIASES` maps the retired `security` key to `account`, and `/profile` redirects per viewer (a consultant or consultee lands on their own Account section; ADMIN/STAFF land on the back-office Settings page; ORG_WORKSPACE lands on `/settings/account`) rather than to a single fixed page. Experience & education lets an expert edit work history and education after onboarding.

The hub root `/settings` and every `?tab=<key>` link answer a 308 to a section, and `/settings/payouts` 308-redirects to `/settings/get-paid` via `[...legacy]/page.tsx` (`GetPaidClient.tsx` lives directly inside `settings/get-paid/`). A jest pin (`__tests__/dashboards/settings-hub.test.tsx`) asserts that every section has a unique URL and that every legacy key lands on exactly one of them.

The consultee (Learner) Settings hub also uses `SettingsLayout`: its sections are Account, Notifications and Learning profile (`CONSULTEE_SETTINGS_SECTIONS` in the consultee tree's own `settings.ts`), following the same one-URL-per-section pattern.

## Where things are

| Concern                                    | File                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Sidebar groups, mobile tabs, crumb labels  | `lib/dashboard/nav/consultant.ts`, `app/dashboard/consultant/[consultantId]/layout.tsx`                             |
| Shared shell, switcher, header menus       | `components/dashboard/DashboardShell.tsx`, `components/dashboard/ContextSwitcher.tsx`                               |
| Availability page                          | `app/dashboard/consultant/[consultantId]/(features)/availability/page.tsx`                                          |
| Offerings list, share attribution & editor | `components/offerings/list/OfferingsTabs.tsx`, `components/offerings/**`                                            |
| Earnings, fee waivers, TDS & analytics     | `app/dashboard/consultant/[consultantId]/(features)/earnings/{EarningsBuckets,AnalyticsPanel}.tsx`                  |
| Reviews inbox, filters & share modal       | `app/dashboard/consultant/[consultantId]/(features)/reviews/ReviewsInbox.tsx`                                       |
| Section registry and redirects             | `app/dashboard/consultant/[consultantId]/(features)/settings/settings.ts`                                           |
| Get paid client & section page             | `app/dashboard/consultant/[consultantId]/(features)/settings/get-paid/{page,GetPaidClient}.tsx`                     |
| Hub nav                                    | `components/dashboard/SettingsLayout.tsx`, `app/dashboard/consultant/[consultantId]/(features)/settings/layout.tsx` |
| Shared form state and the combined PUT     | `app/dashboard/consultant/[consultantId]/(features)/settings/use-consultant-settings-form.ts`                       |
| Pins                                       | `__tests__/dashboards/settings-hub.test.tsx`, `__tests__/dashboard/nav-targets-resolve.test.ts`                     |
