# The expert page's booking dialog: day-cell states, the monochrome slot list and the Today control

**Date:** 2026-09-21 · **Issue:** #1785 · **Scope:** `app/explore/experts/[consultantId]/ExpertProfileClient.tsx`, `day-state.ts`, `hooks/useAvailabilityWindow.ts`, `components/ConsultationPricingToggle.tsx`, `components/SlotList.tsx`, `components/slot-list-policy.ts`.

This page describes what a consultee sees in the "Book Now" dialog on an expert's public page, and the rules behind it. The decisions were locked by the owner on 2026-09-21 after a check against the Calendly and Cal.com booking calendars; they follow the quiet-monochrome design system of 2026-09-06, so no state is carried by colour alone.

## The calendar's day cells

Every day cell has one of these states, computed by `dayState(date, now, daySlots)` in `day-state.ts`.

| State            | What it means                                          | How it looks                                            | Clickable |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------- | --------- |
| `past`           | The day is before today.                               | Dimmed (`opacity-40`) and grey.                         | No        |
| `none`           | The day has no slot that could be booked.              | Plain grey number.                                      | No        |
| `bookable`       | At least one slot is neither past nor fully booked.    | A thin ring (`ring-1 ring-white/40`) and a bold number. | Yes       |
| `today+bookable` | Today, with a bookable slot.                           | The ring, the bold number and a 4 px dot under it.      | Yes       |
| `today+none`     | Today, with nothing left to book.                      | Plain grey number with the dot.                         | No        |
| `unknown`        | The month's marks are still loading or failed to load. | Plain number; it pulses while loading.                  | Yes       |
| `today+unknown`  | Today while the marks are unavailable.                 | Plain number with the dot.                              | Yes       |

The selected day is filled white in every state, as before.

The ring is earned by a real bookable slot, not by published hours. Cal.com's calendar once marked a day available when every slot on it was already taken (calcom/cal.diy#2329), which sends people into an empty list; here a day whose every slot is `fully-booked`, or whose remaining slots all start inside the 15-minute checkout lead time, is `none`. The marks come from one read of the visible month through `useAvailabilityMonth`, which calls `/api/scheduling/availability-with-allocation/[consultantId]` for the month's first to last day, keyed in react-query on `["availability-month", consultantId, "yyyy-MM", timezone]` with a 60-second `staleTime`. Paging the calendar therefore costs one request per month, and re-opening the dialog on a loaded month costs none. The route's window cap is 32 days, one more than a month, so a 31-day month that ends daylight-saving time (31 days and one hour of elapsed time) still fits in one call.

A missing mark never blocks a booking. While the month read is pending the cells pulse with a faint ring; if it fails the cells stay plain and clickable and a one-line notice under the grid says "Couldn't load availability marks — pick a day to see its times". Selecting a day still loads that day's slots through the week-window query, exactly as it did before the marks existed.

## The Today control

A ghost "Today" button sits beside the month arrows in the dialog header. It calls the same `handleBookNowClick` that opening the dialog calls: it returns the calendar to the current month and selects today. The arrows carry `aria-label`s ("Previous month", "Next month") because their visible text is a single glyph.

## The slot list

The list shows only the times a consultee can take. `partitionSlotsForList` in `slot-list-policy.ts` drops every slot that is past (`_isPast`, inside the checkout lead time) or `fully-booked` and counts them; when the count is above zero one muted line under the list says "N times on this day are already taken", and when nothing bookable remains that line stands alone with "Pick another day". A day with nothing published at all still says "No available slots for the selected date".

Every bookable time is the same neutral pill (`border-white/[0.12]`, `hover:bg-white/[0.06]`); the selected one is filled white with a ring. A time the expert has to confirm before payment carries a small "Request" tag instead of a colour. `slotNeedsRequest` applies the same rule the button uses (`consultationCtaFor` in `lib/booking/booking-mode.ts`, #1703 D1): every slot under `REQUEST` mode, and a contended slot (`isAllocated` or `partially-booked`) under `INSTANT`. The sentence under the button says what the tag means — "the expert confirms before you pay" — for both arms.

The emerald, amber and rose classes of the old list, the per-row status words ("Past", "Fully booked", "Partially booked", "Request approval") and the four-colour legend strip are gone. A jest pin renders a bookable, a contended and a taken slot and asserts two rows, one tag, one "already taken" line and no `emerald`, `amber` or `rose` class in the markup.

## Pins

| Pin                                                            | File                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `dayState` over a fixed month, and which states are selectable | `__tests__/schedule/booking-calendar-day-state.test.ts`        |
| The slot list's rows, tag, count line and class ban            | `__tests__/schedule/booking-dialog-slot-list.test.tsx`         |
| The route's 32-day window cap                                  | `__tests__/schedule/availability-grid-conditional-get.test.ts` |
