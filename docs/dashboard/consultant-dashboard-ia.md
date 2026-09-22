# Consultant dashboard information architecture: the sidebar groups and the Settings hub

**Date:** 2026-09-21 · **Issue:** #1785 · **Scope:** `app/dashboard/consultant/[consultantId]/layout.tsx`, the `(features)/availability` page and the `(features)/settings` hub.

This page records how the consultant dashboard is organised after the owner review of 2026-09-21, and why. The decisions here are locked; the review checked them against Material's settings pattern and the Calendly and Cal.com dashboards, and they are not to be re-asked.

## The sidebar

The sidebar is a static, unfiltered list of groups, because every surface on a personal dashboard belongs to the one person who owns it. It reads, top to bottom:

| Group     | Entries                                                   |
| --------- | --------------------------------------------------------- |
| (primary) | Home, Messages, Appointments                              |
| Services  | Event Planner, **Availability**, Requests, Collaborations |
| Resources | Documents, Recordings                                     |
| Finance   | Earnings, Referrals                                       |
| Support   | Support requests, Feedback, Help, Settings                |

Two rules shape this list. A sidebar entry must be a distinct destination (ADR 19), which is why Trials lives at `appointments?tab=trials` and Analytics at the Analytics tab of Earnings rather than as entries of their own. And a daily work surface is not a preference: Availability is where a consultant goes to change the hours people can book, often several times a week, so it sits under Services beside the Event Planner and the Requests inbox rather than inside Settings. Calendly and Cal.com both keep Availability at the top level for the same reason.

The mobile tab strip keeps its five most-used pages (Home, Appointments, Requests, Earnings, Settings). Five is the cap, so Availability is reached from the sidebar drawer on a phone.

## The Availability page

`/dashboard/consultant/[consultantId]/availability` renders the same `AvailabilitySection` and `AvailabilityGrid` that the old settings tab mounted, over the same data. The save contract did not move either: `PUT /api/user/consultants/[id]` is a strict schema that expects the whole profile plus the active schedule's slots on every call, so the page holds the full form state seeded from the profile, shows only the availability fields, and sends the payload the tabbed form used to send. That logic lives once, in `settings/use-consultant-settings-form.ts`, and the Profile and Booking requests sections share it.

The retired `settings?tab=availability` deep link answers a 308 to the new page, so older links from onboarding and from emails still resolve.

## The Settings hub

Settings stays one sidebar entry. Material's settings pattern says to group settings under specific section titles and never to split them into synonyms such as "Options" or "Preferences", so there is no sibling entry and no second word for the same thing. Inside, `settings/layout.tsx` renders a titled left nav from the `md` breakpoint up and a scrollable segmented strip below it, and each section is its own route:

| Group                  | Section          | URL                       |
| ---------------------- | ---------------- | ------------------------- |
| Profile & verification | Profile          | `/settings/profile`       |
| Profile & verification | Verification     | `/settings/verification`  |
| Booking requests       | Booking requests | `/settings/booking`       |
| Get paid               | Get paid         | `/settings/get-paid`      |
| Notifications          | Notifications    | `/settings/notifications` |
| Security               | Security         | `/settings/security`      |

The registry for this table is `SETTINGS_SECTIONS` in `settings/settings.ts`; the nav, the header subtitle and the redirects all read from it, and a jest pin asserts that every section has a unique URL and that every legacy `?tab=` key lands on exactly one of them. Because each section is a URL, the browser's back and forward buttons walk between sections, a link into a section can be shared, and no section is more than one click from any other.

The hub root `/settings` and every `?tab=<key>` link answer a 308 to a section, and `/settings/payouts` answers a 308 to `/settings/get-paid`. The Get paid components did not move: `get-paid/page.tsx` is the server component that guards and seeds the read, and it mounts `GetPaidClient` from the `payouts/` folder where it has always lived, so the earnings page, the Home setup row and the payout-requirements helper keep working through the redirect.

The consultee settings page keeps its three tabs. Three destinations do not need a hub, and the pattern above is for the consultant side only.

## Where things are

| Concern                                   | File                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sidebar groups, mobile tabs, crumb labels | `app/dashboard/consultant/[consultantId]/layout.tsx`                                          |
| Availability page                         | `app/dashboard/consultant/[consultantId]/(features)/availability/page.tsx`                    |
| Section registry and redirects            | `app/dashboard/consultant/[consultantId]/(features)/settings/settings.ts`                     |
| Hub nav                                   | `app/dashboard/consultant/[consultantId]/(features)/settings/layout.tsx`                      |
| Shared form state and the combined PUT    | `app/dashboard/consultant/[consultantId]/(features)/settings/use-consultant-settings-form.ts` |
| Pins                                      | `__tests__/dashboards/settings-hub.test.tsx`                                                  |
