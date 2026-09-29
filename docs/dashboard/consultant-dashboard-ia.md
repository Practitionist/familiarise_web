# Consultant dashboard information architecture: the sidebar groups and the Settings hub

**Date:** 2026-09-27 (supersedes the 2026-09-21 version) · **Issue:** #1527 · **PR:** #1842 · **Scope:** `app/dashboard/consultant/[consultantId]/layout.tsx`, `lib/dashboard/nav/consultant.ts`, the `(features)/settings` hub, and the shared `DashboardShell`.

This page records how the consultant (Expert) dashboard is organised after the 2026-09-26/27 dashboard overhaul (PR #1842, part of #1527), and why. It replaces the 2026-09-21 version of this document, which described the sidebar and Settings hub as they stood before that PR. The owner locked "Expert" and "Learner" as the platform's end-user terms during this PR's review rounds; "Consultant" and "Client" no longer appear in the product surface, though the underlying routes, database enums and `consultant`/`consultee` code identifiers are unchanged.

## The shell and the sidebar

The consultant dashboard now shares one `DashboardShell` with every other dashboard tree (personal, organization, workspace and back office), rather than carrying its own chrome. The shell's sidebar begins with the `ContextSwitcher`, which lets a signed-in person move between their Expert dashboard, their Learner dashboard (if they have also bought a session), every organization they belong to, and — for admins and staff — the back office. Below the switcher, the sidebar is a static, unfiltered list of groups, because every surface on a personal dashboard belongs to the one person who owns it. `buildConsultantNav()` in `lib/dashboard/nav/consultant.ts` builds it as:

| Group    | Entries                                        |
| -------- | ----------------------------------------------- |
| Work     | Home, Requests (count badge), Appointments, Messages (unread badge) |
| Business | **Offerings**, Availability, Earnings, **Reviews** |
| Library  | Documents, Recordings                           |
| Grow     | Invite & earn                                   |

"Offerings" is the renamed Event Planner; the old `planner` route now 308-redirects to `offerings`, and Collaborations moved from its own sidebar entry into an Offerings tab. Reviews is a new destination (owner decision Q5) where an expert reads and replies to what learners say. Two rules still shape this list, carried over from the 2026-09-21 review: a sidebar entry must be a distinct destination, and a daily work surface is not a preference, which is why Availability stays in Business rather than moving into Settings.

Settings is no longer a sidebar row. It is one entry in the header's avatar menu (name, email, role, Settings, Sign out) alongside a header **Help ▾** menu (Help Center · Support requests · Send feedback) — both are part of the shared `DashboardShell` header, not this tree's own nav. The pinned footer action is "View public page".

The mobile tab strip carries four tabs plus **Menu**: Home, Requests, Appointments, Messages. Menu opens a sheet with the switcher, the full nav, Settings and Sign out — Availability, Earnings and everything else not in the four tabs is reached from there, replacing the old five-tab strip that left Messages, the planner and Availability unreachable on a phone.

## The Availability page

`/dashboard/consultant/[consultantId]/availability` is unchanged by this PR: it still renders `AvailabilitySection` and `AvailabilityGrid` over the same data, and the save contract is still the strict whole-profile `PUT /api/user/consultants/[id]`. That logic lives once, in `settings/use-consultant-settings-form.ts`, shared with the Profile and Booking requests settings sections. The retired `settings?tab=availability` deep link still answers a 308 to this page.

## The Settings hub

Settings still renders through the shared `SettingsLayout` primitive (a titled left nav at `md`+, a scrollable segmented strip below it, one URL per section), now shared with the consultee, org and back-office trees rather than being consultant-specific. `SETTINGS_SECTIONS` in `settings/settings.ts` reads:

| Group           | Section               | URL                        |
| --------------- | ---------------------- | --------------------------- |
| Account         | Account                | `/settings/account`         |
| Account         | Notifications           | `/settings/notifications`   |
| Public profile  | Profile                | `/settings/profile`         |
| Public profile  | Experience & education | `/settings/experience`      |
| Public profile  | Verification            | `/settings/verification`    |
| Business        | Booking requests        | `/settings/booking`         |
| Business        | Get paid                | `/settings/get-paid`        |

Account is new since the 2026-09-21 version: it absorbed `/profile`, `/settings/change-password` and the old Security tab, so a consultant's name, photo, phone, password, active sessions, connected accounts and account deletion now live in one place shared with the consultee dashboard. `SETTINGS_SECTION_ALIASES` maps the retired `security` key to `account`, and `/profile` now redirects per viewer (a consultant or consultee lands on their own Account section; ADMIN/STAFF land on the back-office "My profile" page; ORG_WORKSPACE lands on workspace settings) rather than to a single fixed page. Experience & education is also new: it lets an expert edit work history and education after onboarding, which previously had no dashboard entry point.

The hub root `/settings` and every `?tab=<key>` link still answer a 308 to a section, and `/settings/payouts` still 308s to `/settings/get-paid`. A jest pin (`__tests__/dashboards/settings-hub.test.tsx`) still asserts that every section has a unique URL and that every legacy key lands on exactly one of them.

The consultee (Learner) Settings hub now also uses `SettingsLayout` rather than its own three-tab page: its sections are Account, Notifications and Learning profile (`CONSULTEE_SETTINGS_SECTIONS` in the consultee tree's own `settings.ts`), following the same one-URL-per-section pattern this document previously said was consultant-only.

## Where things are

| Concern                                   | File                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sidebar groups, mobile tabs, crumb labels | `lib/dashboard/nav/consultant.ts`, `app/dashboard/consultant/[consultantId]/layout.tsx`         |
| Shared shell, switcher, header menus      | `components/dashboard/DashboardShell.tsx`, `components/dashboard/ContextSwitcher.tsx`           |
| Availability page                         | `app/dashboard/consultant/[consultantId]/(features)/availability/page.tsx`                      |
| Section registry and redirects            | `app/dashboard/consultant/[consultantId]/(features)/settings/settings.ts`                       |
| Hub nav                                   | `components/dashboard/SettingsLayout.tsx`, `app/dashboard/consultant/[consultantId]/(features)/settings/layout.tsx` |
| Shared form state and the combined PUT    | `app/dashboard/consultant/[consultantId]/(features)/settings/use-consultant-settings-form.ts`   |
| Pins                                      | `__tests__/dashboards/settings-hub.test.tsx`, `__tests__/dashboard/nav-targets-resolve.test.ts` |
