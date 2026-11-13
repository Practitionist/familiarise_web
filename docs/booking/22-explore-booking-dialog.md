# The expert page's booking dialog: the dark single-time picker, the taken count and held times

**Scope:** `app/explore/experts/[consultantId]/ExpertProfileClient.tsx`, `app/explore/experts/[consultantId]/components/ConsultationPricingToggle.tsx`, `components/scheduling/SingleTimePicker.tsx`, `components/scheduling/MonthGrid.tsx`, `lib/scheduling/single-session-options.ts`, `lib/booking/booking-mode.ts`, `app/api/scheduling/request-for-approval/route.ts`.

This page describes what a consultee sees in the "Book Now" dialog on an expert's public page, and the rules behind it. The dialog is one of the three time pickers the owner chose on 2026-11-12 ([the booking follow-up train](../decisions/2026-11-12-booking-follow-up-train.md), decision 2): the single-time picker, in its dark theme, with a buyer's rules. No state is carried by colour alone.

## Worked example

Hannah Anderson takes instant bookings and offers a ₹500 30-minute consultation; her hours on Wednesday 4 November are 10:00 to 12:00 in Asia/Kolkata. Charlotte Brown, whose profile zone is Asia/Kolkata, opens "Book Now" on the 30-minute card at 09:00 that day.

- **The month.** The left pane shows November 2026. Wednesday 4 carries a dot because it has a free time; days before today are disabled. The arrow keys move between days, Page Down moves to December.
- **The times.** The right pane is headed "Wednesday 4 November" and "Times in Asia/Kolkata". Under "Morning" it lists 10:00, 10:30, 11:00 and 11:30 as buttons. Olivia Anderson has booked 11:00, so 11:00 is not listed and one line says "1 time already taken". The 09:00 and 09:30 times are not offered, because they are past or inside the 15-minute checkout lead, and they are not counted.
- **The pick.** Charlotte picks 10:30; the button fills white and shows a check, and "Continue to Checkout" is enabled. If a poll a minute later shows 10:30 taken, the pick is cleared, the pane says "That time was just taken — pick another." and the button is disabled again.
- **A request expert.** If Hannah's `bookingMode` were `REQUEST`, the button would read "Request this time" with the line "the expert confirms before you pay". If the request door answered that someone else holds 10:30 (`SLOT_TAKEN` or `LOCK_CONTENTION`), 10:30 would come back greyed as "Taken" with "Notify me if this time opens" under it.

## The month grid

`MonthGrid` (`components/scheduling/MonthGrid.tsx`) is an ARIA grid with one tab stop: the arrow keys move by day and week, Home and End to the week's ends, Page Up and Page Down by month. Past days and days outside the allowed window are disabled (`aria-disabled`, still focusable). A day with at least one free time carries a dot and a ring; today carries a dashed ring. The marks come from `monthSummary` in `lib/scheduling/single-session-options.ts`, which runs the same option logic the times pane runs, so a marked day always lists a free time. While the month read is pending the days pulse. A "Today" control returns to the current month and selects today.

The marks and the times come from one read of the visible month through `useAvailabilityMonth` (`lib/scheduling/use-availability-window.ts`), which calls `/api/scheduling/availability-with-allocation/[consultantId]` for the month's first to last day with the buyer as `consulteeUserId`, keyed on `["availability-month", consultantId, "yyyy-MM", timezone, consulteeUserId]`. The read keeps the ETag cache and polls while the tab is visible. The route's window cap is 32 days, so any month fits one call. When the chosen day has nothing free, the pane says "No free times on this day" and offers "Next free: <date>", reading the following month only when this one has nothing left.

## The times pane

`optionsForDay` gives each half-hour start of the chosen day a state. For a buyer:

| State       | When                                                                                                        | Shown                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `free`      | `windowsForDay` makes the window and `isBookableWindow` accepts it                                          | A button; selected, it is filled with a check      |
| `contended` | The request door said someone else holds it (`heldStarts`)                                                  | A greyed button labelled "Taken", with "Notify me" |
| `taken`     | Inside the expert's hours and over a booking                                                                | Not listed; counted in "N times already taken"     |
| (none)      | Past, inside the lead (`leadMsFor`: 15 minutes to book, 2 hours for a priced request), or outside the hours | Neither listed nor counted                         |

Times are grouped Morning, Afternoon and Evening on the viewer's wall clock. Each button has an `aria-label` with the full range and the state ("10:30 am to 11:00 am, free"), and a polite live region announces "N free times on <date>". A session that crosses midnight is one option on the day it starts. Zone-dependent text renders only after mount.

The grid does not say whether a booking is a hold (someone mid-checkout or asking) or confirmed, so a time is shown `contended` only after the request door reports it held. "Notify me" registers backup interest through `NotifyWhenFreeButton` (`POST /api/scheduling/backup-interest`, at most three open).

## The button and the request door

`consultationCtaFor(mode)` reads the expert's `bookingMode` alone. `INSTANT` continues to checkout with the pick's start and end in the URL; `REQUEST` sends `POST /api/scheduling/request-for-approval`. The request door refuses an expert whose `bookingMode` is not `REQUEST` with 409 `REQUEST_NOT_OFFERED` ("This expert takes instant bookings. Pick a free time and continue to checkout."), after the pause check and before any lock. **Enforced by** the route; `__tests__/booking-algorithm/consultant-request-gate.test.ts` pins the refusal.

"Book Now" on a plan card makes that card's plan the active one before it opens the dialog, so the request and the stashed purchase intent carry that card's plan. A guest's pick rides through sign-in in session storage (`utils/purchase-intent.ts`) and is restored once, opening that plan's dialog; the picker clears it if the time has gone.

## Pins

| Pin                                                                       | File                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The option states, the taken count, the month summary and midnight        | `__tests__/scheduling/single-session-options.test.ts`          |
| The keyboard grid, held times with Notify me, the host switch, just taken | `__tests__/scheduling/single-time-picker.test.tsx`             |
| A poll that takes the pick, and "Book Now" on the second card             | `__tests__/explore/selection-just-taken.test.tsx`              |
| The request door's refusal for an instant-booking expert                  | `__tests__/booking-algorithm/consultant-request-gate.test.ts`  |
| The route's 32-day window cap                                             | `__tests__/schedule/availability-grid-conditional-get.test.ts` |

## Deprecated & Superseded Approaches

- **The dialog's own calendar and slot list** (`renderCalendar` in `ExpertProfileClient`, `day-state.ts`, `SlotList.tsx`, `slot-list-policy.ts`, a week read beside the month read). Replaced by `SingleTimePicker` over one month read.
- **A contended time offered as a request on an instant-booking expert** (the "Request" tag and the second arm of `consultationCtaFor`). A held time is taken with "Notify me"; the request door refuses instant-booking experts.
- **"N times on this day are already taken" counting past and too-soon times.** The count is `takenTimesCount`, real bookings only.
