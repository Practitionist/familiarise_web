# ADR: Scheduling surfaces, feasibility before money, and booking correctness

- **Status**: Accepted on 2026-11-09 by the owner. Built in the scheduling surfaces pull request (branch `feat/booking-scheduling-surfaces`). Items marked **(planned)** are not built yet.
- **Date**: 2026-11-09
- **Author**: Platform engineering
- **Related**: [Booking v2 direction](2026-11-03-booking-v2-direction.md), [Booking v2 train B](2026-11-04-booking-v2-train-b.md), [Allocate heat-map UX](../calendar/allocate-heatmap-ux.md), issues [#2586](https://github.com/Practitionist/familiarise_web/issues/2586) (colour scheme, next pass), [#2595](https://github.com/Practitionist/familiarise_web/pull/2595) (Regular time, separate)

## Context

Three read-only audits of `dev` at `b3d86d012` (math and quotas, event and trial flows, concurrency and state machines) found that the booking engine agrees with itself and the lock discipline holds. They also found:

- **No feasibility check before money moves.** A plan whose cadence the expert's hours can never hold sold normally and first failed after payment, as `SLOT_SHORTAGE` or `NO_AVAILABILITY`.
- **A sold webinar or class could be re-planned.** "Manage timings" ran the allocator over a live event, which replaced its sessions without the 24-hour notice or the free-leave refund that re-time carries.
- **Host-set event times had no rules.** The webinar editor used a browser-zone `datetime-local` with no future, lead or half-hour check, and its end was computed with `setHours`, so a 90-minute webinar's slot ended after 60. A class make-up accepted any future instant. Re-time was picked blind, with no free/busy view.
- **Classes could only be placed on the desktop week grid**, reached from an Appointments row action. There was no way to move a sold class's future sessions except one cancel (a host miss) and one make-up at a time.
- **Math defects.**
  - A weeks plan bought after local midnight showed "Week 1 of 27" for a 26-week plan, and ended with a sub-day stub week that still asked for a full week's sessions.
  - A subscription plan accepted a 45-minute session, which was sold as 45 and booked as 60.
  - Two plan doors skipped the plan schema entirely.
  - Auto-schedule stacked two class sessions on one day while other days were free.
- **The heat map reads poorly.** Each half hour is its own small gapped pill, dead cells are transparent, and dead hours fold away (mid-day gaps included). Eight layers of banners, toolbar and footer squeeze the grid.

## Decisions

1. **A sold group event is re-timed, never re-planned.** Once a webinar or class has a live buyer seat (a `CONSULTEE` participant that is HELD, CONFIRMED or ATTENDED), the allocator refuses a re-plan with 409 `USE_RETIME` inside its transaction (`assertGroupEventUnsoldInTx`). A top-up that only appends sessions is still allowed. The host's menu hides Timings, and the timings page points a sold event at Re-time.

2. **One rule set for host-set event times** (`lib/booking/event-time-rules.ts`).
   - A webinar start or class make-up sits on the UTC half-hour lattice and is at least an hour away. A re-time keeps its 24 hours.
   - An end is the start plus whole minutes.
   - The webinar POST and PATCH (a changed time only) and the make-up refuse anything else with `EVENT_TIME_INVALID`.

3. **One single-session picker for hosts** (`SingleSessionPicker`). It shows a strip of days and every half-hour start, labelled Free, Outside your hours, Busy or Too soon, in the host's zone, and it works on a phone. It replaces the webinar editor's date-time input, the re-time dialog's date and time select, and the make-up input. A host may run an event outside their published hours: those starts stay pickable and are only labelled.

4. **Classes are scheduled from a weekly pattern** (`ClassPatternScheduler`, `lib/booking/class-pattern.ts`).
   - The host gives a first day plus weekday and time rows. The scheduler previews the N sessions and labels each one against the host's calendar.
   - Saving sends exactly those times to the allocator, which re-checks them.
   - Patterns are projected on the host's wall clock, so a daylight-saving change keeps 18:00 at 18:00. The editor's start-date series goes through the same projection.
   - The week grid stays available as the calendar view.
   - The owner will judge this in QA. The fallback is the grid made discoverable, plus a mobile day list.

5. **A sold class's upcoming sessions move as a series** (`retimeClassSeries`, `POST /api/appointments/[id]/retime-series`).
   - Every session at least 24 hours away moves in place to a new pattern. Nearer sessions keep their time.
   - The host and accepted co-hosts must be free; attendee clashes are flagged and never block.
   - Every seat may leave with a full refund until `retimeBy`.
   - A move is not a cancel: no host miss is recorded and no exit-right count changes.

6. **Feasibility before money** (`lib/booking/feasibility.ts`). The expert's published hours are projected the way the allocator reads them: zone days, the half-hour lattice, the per-day cap.
   - **Plan editor:** publishing a subscription plan, or editing its terms, refuses with 422 `PLAN_NOT_FEASIBLE` when no week can hold the cadence. Drafts save, with the reasons shown as warnings.
   - **Checkout:** the buyer sees "This expert currently has room for about N of 3 sessions a week" when some of the first four weeks can't hold the cadence around today's bookings. Checkout refuses with 409 `NOT_PLACEABLE` only when the first week holds nothing at all.

7. **Plan math.**
   - A weeks plan ends at the zone midnight that closes its last plan week, so there is no stub week. Rows already sold keep their stamped end.
   - Every plan door parses one cadence schema: 1–7 whole sessions a week, and lengths on the 30-minute grid.
   - The monthly pacing arm is deleted. Quotas are per day, per plan week and per plan total.
   - Classes get the same spaced-first auto sweep as subscriptions, then a one-a-day sweep, and stack two a day only last.

8. **Grid structure** (palette and the 12 states unchanged until the colour pass).
   - A continuous ruled canvas, with no dead-hour folding: an "Open hours | Full day" toggle replaces it.
   - Whole-session blocks over the cells.
   - A hover preview of exactly the session a click places.
   - A session tray for picks, quota and actions.
   - One context row instead of stacked banners.
   - A month view that counts whole sessions that fit.

9. **Money and stuck states.**
   - A class that completes with sessions sold but never placed refunds each seat for them. The amount is floor(seat paid × unplaced ÷ sessions the seat bought), less any earlier class-end refund. The completing commit stamps a `class-end:` refund-owed marker, and the retry sweep drives it, so the payment's earnings stay held until it settles. A seat whose payment already owes another door's refund holds the completion until that clears.
   - A consultation parked after a failed restore cancels with a full refund after 7 days, or 48 hours past its original time, whichever is first. It records a strike only when the consultant started the move.
   - The 30-day "approved but unallocated" refund applies only to plans that never started: no confirmed session ever (tombstones included) and no reschedule request ever.
   - A consultee cannot release or cancel a single subscription session inside 24 hours. Returns need 24 hours, and a no-show is recorded as delivered, so such a session is already forfeited at plan end. This is now pinned by a test.
   - Reschedule POST takes an `Idempotency-Key` and replays a committed outcome through the shared `withIdempotency` store. A request killed mid-flight keeps its key busy (409 `IDEMPOTENCY_IN_FLIGHT`) until the page is reloaded, which mints a new key.
   - A session parked for ops more than 7 days goes on the ops list.
   - Hardening:
     - Single-key locks never orphan themselves, and a lost lock renewal aborts with 409.
     - Manual and requested allocation take the consultee key after their reads.
     - A reused wrapper keeps its first allocation key.
     - Read Committed booking transactions replay once on a deadlock.
     - Two webhook payment writes settle by compare-and-set.

## Alternatives considered

- **Webinars on the full week grid.** Rejected: a webinar is one session. A full grid adds availability-matching that doesn't exist for a host's own event, and it can't run on a phone.
- **Validation only, keeping `datetime-local`.** Rejected: it fixes the server but leaves hosts picking blind and in the browser's zone.
- **Grid only for classes, made discoverable.** Kept as the fallback if the pattern scheduler disappoints in QA.
- **Blocking a sold event re-plan without a series move.** Rejected: hosts would cancel session by session, and every cancel counts as a host miss toward learners' exit right.
- **Hard-blocking checkout whenever the whole plan doesn't fit today's hours.** Rejected: availability changes week to week. The plan-end choice and settlement already make an unplaced session refundable, so the buyer is told rather than refused.
- **A monthly quota.** Rejected: plans are paced in plan weeks. A month cap adds a second clock that can contradict the weekly one.
- **Collapsing the 12 visual states now.** Deferred by the owner to the colour pass.

## Not built (and why)

- **Regular time, the 4-week roll-forward, the conflict list and catch-up:** these are #2595, kept separate. It rebases after this merges.
- **The plan-end extra-weeks choice and `extendPlan()`** (train-B decision 9): planned, after #2595.
- **A Home "Needs you" item for an unscheduled class** (planned). The offering card's "Schedule now" link covers discovery for now.

## Deprecated & Superseded Approaches

- **Re-planning a live webinar or class through Manage timings.** Replaced by re-time (webinar) and the series move (class).
- **`datetime-local` event times** (the webinar editor, the class make-up) and the blind re-time date and time select. Replaced by `SingleSessionPicker`.
- **`retimeStartsOn`.** Deleted; the picker owns the lattice and the lead.
- **Server-local `setDate` series generation for classes.** Replaced by `seriesStartsFrom`.
- **The monthly `CycleUnit` arm.** Deleted.
- **Dead-hour folding on the heat map.** Replaced by the open-hours window.
