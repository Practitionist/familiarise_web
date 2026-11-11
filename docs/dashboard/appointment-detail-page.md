# The appointment detail page

This page explains how the appointment detail page is laid out and why. The page is the same component for every booking kind (consultation, subscription, webinar, class, trial) and every viewer (consultant, consultee, organisation): `AppointmentDetailClient` in `components/appointments/detail/`, mounted by the `appointments/[appointmentId]/page.tsx` route of each dashboard tree.

## The layout

The page has three parts, read top to bottom.

1. **The header.** An eyebrow names the kind ("Class", "Subscription") beside the one status chip; the title follows, then the other party with their avatar and the session count. Under it, a **Next up** panel shows the next session as a day tile, the time range, the full date and a live countdown. When the other party's saved time zone differs from the viewer's, the panel adds their wall clock ("Mon 5:30 AM for Hannah (GMT)"), so neither side converts a time in their head. The needs-you callout (Pay, Approve, Join, Rate) and the chat and schedule buttons sit inside the header, because they are the page's primary actions.
2. **The main column.** Notices, the open reschedule proposal, the review nudge, then the **Sessions** card and, for the host, the participants.
3. **The right rail.** Payment, details, resources, the timeline and help, in that order. The rail stays narrow (280–340 px) so the sessions keep the width.

Destructive booking actions (Cancel booking, Withdraw request) stay in the "Manage booking" row at the foot of the page, after Get help, so they never lead the page.

## One list of sessions

The Sessions card renders `SessionSchedule` (`components/appointments/detail/SessionSchedule.tsx`), which replaces the old pair of a compact timeline plus a second list of the same dates carrying "Cancel this session" or "Return to plan" buttons.

- **Rows.** Each row is a day tile, the time range, a detail line ("Session 4", the length when lengths differ, "Same day as another session") and the row's status.
- **Status.** Upcoming is the default and carries no word. The next session shows its countdown, a session in its join window shows Join, and only the states a reader must notice carry a word and a dot: Done, Cut short, No-show, Verifying, No record, Live now. Colour is kept for those exceptions; the colour palette itself is a separate pass.
- **Per-session actions.** A row's actions come from `rowActions(session)`. The first enabled, non-destructive action also shows inline on hover or keyboard focus; every action is in the row's menu. A blocked action stays in the menu, disabled, with its reason under the label (for example why a session can't be returned to the plan). Confirmation goes through one shared `SessionConfirmDialog`.
  - The host's "Cancel this session" for a class comes from `useClassSessionActions` (`ClassSessionControls.tsx`). Make-up work, which needs a time or a decision, renders as notices above the list.
  - The consultee's "Return to plan" for a subscription comes from `useSubscriptionReturnActions` (`SubscriptionReturnControls.tsx`), with the rule and the returns used as a footnote under the list.
- **Grouping.** Past sessions fold behind "N past sessions". Upcoming sessions are grouped by week when the schedule spans weeks. Weeks are counted from the first session's day in the viewer's zone (`buildScheduleModel` in `lib/appointments/session-schedule.ts`), so a week never splits at the server's midnight. An empty week between sessions is listed as "No sessions this week", and a week with fewer sessions than the plan's weekly count says "1 of 2 this week".
- **Progress.** A class shows one "N of M done" bar at the top of the card. A subscription keeps its entitlement count in the header ("1 of 4 sessions scheduled") and shows no second bar.
- **Time zone.** The zone is named once, above the list ("Times shown in IST (UTC+05:30)"), with a switch to the device's zone when it differs. Rows never repeat the zone.

## Money on a group event

The host's Payments card for a webinar or class counts seats, not amounts. A paid seat that cost nothing (a free event or a full discount) is counted as a free seat, and when every paid seat was free the card says "Nothing — every paid seat was free" instead of a bare "₹0.00 collected".

## The public class schedule

The class listing's schedule (`BatchSchedule` under `app/explore/programs/plans/classes/[classPlanId]/components/`) follows the same rules. It names the zone once per batch, shows no status pill on upcoming sessions, groups by week in the page's zone through the same `buildScheduleModel`, and shows a session's length only when lengths differ. When fewer sessions are on the calendar than the plan sells, the enrolment line says so: "Join now for ₹X · all 24 sessions (12 scheduled so far)".

## Deprecated & Superseded Approaches

- **A second list of session actions.** `ClassSessionControls` and `SubscriptionReturnControls` used to render their own list of upcoming dates under the Sessions card, each with a button. The same dates appeared twice. The actions now live on the session rows.
- **`SessionTimeline` on the detail page.** The compact timeline with uppercase status words (UPCOMING, COMPLETED) and emoji icons is still used by `AppointmentSheet`, but the detail page no longer renders it.
- **A zone suffix on every row.** The public schedule printed "GMT+5:30" after every time; the zone is now named once per batch.
- **`groupSessionsByWeek`.** It grouped weeks at the runtime's midnight and was removed in favour of `buildScheduleModel`.
