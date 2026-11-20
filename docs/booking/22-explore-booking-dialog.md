# The expert page's booking dialog: the dark single-time picker and the taken times you can wait on

**Scope:** `app/explore/experts/[consultantId]/ExpertProfileClient.tsx`, `app/explore/experts/[consultantId]/components/ConsultationPricingToggle.tsx`, `components/scheduling/SingleTimePicker.tsx`, `components/scheduling/MonthGrid.tsx`, `lib/scheduling/single-session-options.ts`, `components/booking/NotifyWhenFreeButton.tsx`, `lib/booking/picked-time.ts`, `lib/booking/booking-mode.ts`, `app/api/scheduling/request-for-approval/route.ts`, `app/explore/experts/[consultantId]/hooks/useChooseAnotherTime.ts`, `app/checkout/plans/adapters/use-consultation-checkout.tsx`.

This page describes what a consultee sees in the "Book Now" dialog on an expert's public page, and the rules behind it. The dialog is one of the three time pickers the owner chose on 2026-11-12 ([the booking follow-up train](../decisions/2026-11-12-booking-follow-up-train.md), decision 2): the single-time picker, in its dark theme, with a buyer's rules. No state is carried by colour alone.

## Worked example

Hannah Anderson takes instant bookings and offers a ₹500 30-minute consultation; her hours on Wednesday 4 November are 10:00 to 12:00 in Asia/Kolkata. Charlotte Brown, whose profile zone is Asia/Kolkata, opens "Book Now" on the 30-minute card at 09:00 that day.

- **The month.** The left pane shows November 2026. Wednesday 4 carries a dot because it has a free time; days before today are disabled. The arrow keys move between days, Page Down moves to December.
- **The times.** The right pane is headed "Wednesday 4 November" and "Times in Asia/Kolkata". Under "Morning" it lists 10:00, 10:30 and 11:30 as buttons. Olivia Anderson has booked 11:00, so 11:00 is not among them; below the free times a button reads "Show 1 taken time". The 09:00 and 09:30 times are not offered, because they are past or inside the 15-minute checkout lead, and they are not listed anywhere.
- **The taken times.** Charlotte presses "Show 1 taken time". It turns into "Hide taken times" and opens a list with one greyed row, "11:00 am to 11:30 am", a "Notify me" button and the line "You can wait on up to 3 times." She presses "Notify me": the row now reads "Waiting" with "Withdraw". If 11:00 frees (Olivia cancels, or a hold lapses), Charlotte gets a bell and an email; nothing is held for her, so the first to book gets it. Had she already waited on three other times, the server's refusal ("You can wait on at most 3 times at once — withdraw one to add another.") would show under the button. Had she not been signed in, "Notify me" would send her to sign in and bring her back to this dialog on 4 November with the list open.
- **The pick.** Charlotte picks 10:30; the button fills white and shows a check, and "Continue to Checkout" is enabled. The pick carries the availability row it was cut from, so the checkout URL names it (`availabilityWindowWeeklyId` or `availabilityWindowCustomId`) as checkout requires. If a poll a minute later shows 10:30 taken, the pick is cleared, the pane says "That time was just taken — pick another.", the taken list opens and the button is disabled again.
- **A request expert.** If Hannah's `bookingMode` were `REQUEST`, the button would read "Request this time" with the line "the expert confirms before you pay". If the request door answered that someone else holds 10:30 (`SLOT_TAKEN` or `LOCK_CONTENTION`), the pick would clear, the pane would say "That time was just taken — pick another." and the taken list would open with 10:30 in it.

## The month grid

`MonthGrid` (`components/scheduling/MonthGrid.tsx`) is an ARIA grid with one tab stop: the arrow keys move by day and week, Home and End to the week's ends, Page Up and Page Down by month. Past days and days outside the allowed window are disabled (`aria-disabled`, still focusable). A day with at least one free time carries a dot and a ring; today carries a dashed ring. The marks come from `monthSummary` in `lib/scheduling/single-session-options.ts`, which runs the same option logic the times pane runs, so a marked day always lists a free time. While the month read is pending the days pulse. A "Today" control returns to the current month and selects today.

The marks and the times come from one read of the visible month through `useAvailabilityMonth` (`lib/scheduling/use-availability-window.ts`), which calls `/api/scheduling/availability-with-allocation/[consultantId]` for the month's first to last day with the buyer as `consulteeUserId`, keyed on `["availability-month", consultantId, "yyyy-MM", timezone, consulteeUserId]`. The read keeps the ETag cache and polls while the tab is visible. The route's window cap is 32 days, so any month fits one call. When the chosen day has nothing free, the pane says "No free times on this day" and offers "Next free: <date>", reading the following month only when this one has nothing left.

## The times pane

`optionsForDay` gives each half-hour start of the chosen day a state. For a buyer:

| State       | When                                                                                                        | Shown                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `free`      | `windowsForDay` makes the window and `isBookableWindow` accepts it                                          | A button; selected, it is filled with a check |
| `contended` | The request door said someone else holds it (`heldStarts`)                                                  | In the taken list, with "Notify me"           |
| `taken`     | Inside the expert's hours and over a booking or a hold                                                      | In the taken list, with "Notify me"           |
| (none)      | Past, inside the lead (`leadMsFor`: 15 minutes to book, 2 hours for a priced request), or outside the hours | Not listed anywhere                           |

Times are grouped Morning, Afternoon and Evening on the viewer's wall clock. Each button has an `aria-label` with the full range and the state ("10:30 am to 11:00 am, free"), and a polite live region announces "N free times on <date>". A session that crosses midnight is one option on the day it starts. Zone-dependent text renders only after mount.

## The taken times and "Notify me"

Free times show by default. When the day has taken times (`takenTimes`: booked or held, inside published hours, in time order), one disclosure button reads "Show N taken times" and, open, "Hide taken times"; it is a native button with `aria-expanded` and `aria-controls`, so Enter and Space work. The open list shows each taken time greyed with `NotifyWhenFreeButton`. This applies whether the expert takes instant bookings or reviews requests first; the host's picker has no such list. The list opens by itself when the request door refuses the pick as held, and when a poll shows the pick taken.

"Notify me" registers backup interest (`POST /api/scheduling/backup-interest`, `registerBackupInterest` in `lib/booking/backup-interest.ts`), which accepts any future window. A time the learner already waits on reads "Waiting" with "Withdraw" (`DELETE`), read from the learner's own list (`GET`, the same query the dashboard's alerts read). The cap of three (`BACKUP_INTEREST_CAP`) is the server's rule; its refusal shows under the button, and the list carries the helper line "You can wait on up to 3 times." A signed-out visitor's "Notify me" stashes the time with `waitOn` (`utils/purchase-intent.ts`) and goes to sign in; back on the page, the dialog reopens on that day with the list open.

Waiters hear when the time frees: the cancel route stages notices for a cancelled 1:1 (`stageNoticesForAppointmentHolds` with `includeConfirmed`), and the abandoned-checkout sweep, order reuse, request lapses and moves stage them for a lapsed hold or a freed window. Other buyer pickers (the trial step, the trial reschedule, the organisation's allocation) list taken times without "Notify me".

## The button and the request door

`consultationCtaFor(mode)` reads the expert's `bookingMode` alone. `INSTANT` continues to checkout with the pick's start, end and availability row in the URL (`consultationCheckoutHref` in `lib/booking/picked-time.ts`); `REQUEST` sends `POST /api/scheduling/request-for-approval` with the same three (`requestForApprovalBody`). The request door refuses an expert whose `bookingMode` is not `REQUEST` with 409 `REQUEST_NOT_OFFERED` ("This expert takes instant bookings. Pick a free time and continue to checkout."), after the pause check and before any lock. **Enforced by** the route; `__tests__/booking-algorithm/consultant-request-gate.test.ts` pins the refusal.

"Book Now" on a plan card makes that card's plan the active one before it opens the dialog, so the request and the stashed purchase intent carry that card's plan. A guest's pick rides through sign-in in session storage (`utils/purchase-intent.ts`) and is restored once, opening that plan's dialog; the picker clears it if the time has gone.

## Back from checkout when the time is gone

A time can stop being buyable between the pick and the payment. Checkout sends the buyer back to this dialog, on the same plan with nothing picked, whenever the refusal means the time can never be bought as picked. The return address is `chooseAnotherTimeHref` in `app/explore/experts/[consultantId]/hooks/useChooseAnotherTime.ts`: `/explore/experts/<id>?conflict=1&plan=<planId>`. `conflict=1` makes the grid's next read skip the browser cache, and `plan` opens that plan's dialog (`chooseAgainLinkSchema` in `ConsultationPricingToggle`); a plan the expert does not offer opens nothing. The link outranks a purchase intent saved before sign-in: the saved pick is discarded, whether the session is ready on arrival or arrives later, so the dialog never opens on, or switches to, an older time. Recovery is a one-time entry: a guest who picks or presses "Notify me" from the link is sent to sign in with `conflict` and `plan` dropped from the return address, so the pick stashed for that bounce is restored.

- **Refused at Pay.** `isTerminalSlotRefusal` in `lib/errors/classification/payment-error-classification.ts` lists the codes: `SLOT_TAKEN` (409, another buyer was first), `SLOT_TOO_SOON`, `SLOT_NOT_ON_GRID` and `SLOT_TOO_FAR` (400, from the Zod edge; the last is a start more than 90 days ahead). The consultation checkout's `onCheckoutRefusal` toasts the refusal's own title and the server's sentence (for example "That time is now too close" with "This time slot starts too soon (in 9 minutes)…") and returns the buyer to the dialog. The refusal may arrive from the route or through the Razorpay button's error callback; both reach the same handler.
- **Not refused for good.** Lock contention, a busy or serialization conflict and payment failures keep the buyer on the checkout page with a toast, because the same time may still succeed.
- **Gone before the page opens.** A time that has passed or starts inside the 15-minute lead still loads the plan, then shows "This time can't be booked" with one action, "Choose another time", linking to the same address. The minute-by-minute check shows the same view when the time passes while the page is open. The grid re-ask before Pay, when it finds the time no longer offered for any reason, toasts "That time is no longer available — pick another." and returns the buyer to the dialog.

## Pins

| Pin                                                                                             | File                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The option states, the taken list, the month summary and midnight                               | `__tests__/scheduling/single-session-options.test.ts`          |
| The keyboard grid, the taken-times disclosure, the host switch, just taken                      | `__tests__/scheduling/single-time-picker.test.tsx`             |
| A poll that takes the pick, a held refusal, "Book Now" on the second card                       | `__tests__/explore/selection-just-taken.test.tsx`              |
| Checkout's return link opens the refused plan's dialog with nothing picked, over a saved intent | `__tests__/explore/selection-just-taken.test.tsx`              |
| Every terminal refusal at Pay returns to the grid; contention stays                             | `__tests__/payments/checkout-choose-another-time.test.tsx`     |
| "Notify me", "Waiting" with a withdraw, the inline refusal, sign-in                             | `__tests__/growth/notify-toggle-wrappers.test.tsx`             |
| A pick's checkout URL, request body and trial body parse at their doors                         | `__tests__/booking/picked-time-contract.test.ts`               |
| The request door's refusal for an instant-booking expert                                        | `__tests__/booking-algorithm/consultant-request-gate.test.ts`  |
| The route's 32-day window cap                                                                   | `__tests__/schedule/availability-grid-conditional-get.test.ts` |

## Deprecated & Superseded Approaches

- **The dialog's own calendar and slot list** (`renderCalendar` in `ExpertProfileClient`, `day-state.ts`, `SlotList.tsx`, `slot-list-policy.ts`, a week read beside the month read). Replaced by `SingleTimePicker` over one month read.
- **A contended time offered as a request on an instant-booking expert** (the "Request" tag and the second arm of `consultationCtaFor`). A held time is taken with "Notify me"; the request door refuses instant-booking experts.
- **"N times on this day are already taken" counting past and too-soon times**, and then the count line itself (`takenTimesLine`). Replaced by the "Show N taken times" disclosure.
- **Only a taken time returned the buyer to the grid** (`useSlotJustTaken`). A too-soon or off-grid refusal toasted with no way forward, and a time gone at page load ended on "Please go back and select a new slot". Replaced by `useChooseAnotherTime` for every terminal refusal.
- **"Notify me" only after a refusal** (a held time shown greyed among the free ones, "Notify me if this time opens"). Every taken time is listed behind the disclosure with "Notify me".
