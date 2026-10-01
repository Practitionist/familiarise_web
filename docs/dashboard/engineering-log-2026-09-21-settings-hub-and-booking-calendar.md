# PR-L: Availability at top level, Settings as a grouped hub, and a booking calendar that tells the truth about days

**Date:** 2026-09-21 · **Issue:** #1785 · **Branch:** `feat/settings-hub-and-booking-calendar` · **Scope:** the consultant dashboard's sidebar and Settings, and the expert page's booking dialog.

This entry records what PR-L changed and why, in the order the work was committed. The product decisions came from the owner review of 2026-09-21 and are recorded on issue #1785; this log is about how they were carried out.

## L-1: Availability became a sidebar destination

The consultant's availability editor was the second of six tabs inside a 700-line `SettingsTab` component. It is a daily work surface, so it now lives at `/availability` under the sidebar's Services group, between the Event Planner and Requests. The page mounts the existing `AvailabilitySection` and `AvailabilityGrid` unchanged.

The only real engineering question was the save contract. `PUT /api/user/consultants/[id]` is a strict Zod schema that refuses unknown keys and requires the whole profile plus the active schedule's slots on every call, and the tabbed component satisfied it by holding one form state for all its tabs. Splitting the tabs into pages could not change the payload, so the form state, the content reads and the submit handler were lifted into `useConsultantSettingsForm`, a hook that every page holding a slice of that form uses. Each page seeds the full state from the profile and shows only its fields; the payload is byte-for-byte what the tabbed form sent. The hook takes two flags: `content` for the domain, sub-domain and tag lists only the Profile section renders, and `scheduleSwitch` for the WEEKLY-to-CUSTOM lock only the Availability page shows, so the other pages do not pay for reads they do not use.

`settings/page.tsx` became a server component so that a retired `?tab=availability` link answers a real 308 rather than a client-side hop, and the sidebar's `PAGE_LABELS` gained the new segment so the breadcrumb reads "Availability".

## L-2: Settings became a grouped hub with one URL per section

`SettingsTab` was deleted. `settings/layout.tsx` renders the header, a titled left nav from `md` up, a scrollable strip below it, and the section route as its body; the sections are `profile`, `verification`, `booking`, `get-paid`, `notifications` and `security`, each a folder with a page. The registry that drives the nav, the header subtitle, the crumb labels and the redirects is `SETTINGS_SECTIONS` in `settings/settings.ts`.

The Get paid page kept its components in `payouts/` (the source-text pin in `get-paid-page.test.tsx` was re-pointed to the new page path, and it still asserts that only the client component crosses the server boundary). `payouts/page.tsx` is now a redirect, because the earnings page, the Home setup row and `payoutRequirements` still link to the old URL and those files belong to other trains.

The verification banner and the REJECTED gate in the dashboard layout now link to `/settings/verification`. The Requests page's "turn it back on in Settings" link still says `settings?tab=booking`; it is redirected rather than edited because that page is being rewritten by the Requests inbox PR (#1783) at the same time.

## L-3: the slot list went monochrome

The booking dialog's slot list painted available slots emerald, contended amber, taken rose and past grey, and in practice read as a wall of green. `SlotList` now lists only bookable times as neutral pills, marks a time the expert must confirm with a "Request" tag, and folds taken and past times into one muted count line. The pure rules (`partitionSlotsForList`, `takenTimesLine`, `slotNeedsRequest`) live in `slot-list-policy.ts` so the pin needs no DOM beyond `renderToStaticMarkup`. `consultationCtaFor`'s `INSTANT` contended arm gained a hint sentence so the tag is explained under the button on both arms.

## L-4: day cells carry real state, and there is a Today button

`renderCalendar` rendered every day identically. It now reads the visible month once through `useAvailabilityMonth` and classifies each cell with `dayState`. The rule for the ring is the cal.diy#2329 rule: at least one slot that is neither past nor fully booked, so a day whose hours are all taken shows nothing. The month read is keyed on the month with a 60-second `staleTime`; a pending read pulses the cells, a failed read leaves them clickable under a one-line notice, and selecting a day still loads its slots through the week-window query.

The route's `MAX_AVAILABILITY_WINDOW_DAYS` moved from 31 to 32, because a 31-day month that ends daylight-saving time is 31 days and one hour of elapsed time and the month read must fit in one call. The conditional-GET pin and the grid-cost doc were updated to say 32.

`refreshSlots` now invalidates both the week and the month queries, so the refresh button in the dialog refreshes the marks as well as the list.

## What was left alone, and why

The `UserDropdown` component takes its settings path as a prop and has no callers, so there was nothing to re-point. The Home tab's "Set up availability" buttons link to the Event Planner and belong to the Requests inbox PR's file set; they are not wrong, and can move to `/availability` in a later pass. The consultee settings page keeps its three tabs.
