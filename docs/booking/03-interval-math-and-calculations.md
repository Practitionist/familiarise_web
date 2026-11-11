# Slot Math & Calculations

All slot math lives in `utils/scheduling-engine/ScheduleCalculationService.ts`.

## Fundamentals

Every time slot in the system is a **30-minute atomic unit**.

- `SCHEDULING_INTERVAL_MS = 30 * 60 * 1000` (1,800,000 ms)
- 48 intervals per day (24h / 0.5h)
- `slotsPerSession = Math.ceil(sessionDurationInHours / 0.5)`

| Duration  | Slots |
| --------- | ----- |
| 0.5 hours | 1     |
| 1 hour    | 2     |
| 1.5 hours | 3     |
| 2 hours   | 4     |
| 2.5 hours | 5     |
| 3 hours   | 6     |
| 4 hours   | 8     |

## Sessions Versus Slot Rows

The arithmetic above has an invariant hiding inside it that is worth stating on its own, because everything downstream of booking depends on it.

> A **session** is N **contiguous** slot rows on one appointment. A slot row is not a session. Any surface that treats one row as one session is wrong.

A one-hour consultation is two rows, a four-hour consultation is eight, and in both cases the customer booked exactly one meeting. The rows are a storage detail of the allocator, not something a user ever asked for or should ever be shown.

### `groupSlotsIntoRuns` Is the Single Definition

`groupSlotsIntoRuns` in `lib/appointments/occurrences.ts` is the one place that decides what counts as a session. Any surface that needs to answer "which rows make up this session?" must call it rather than walking the rows itself. It encodes four rules, in this order.

1. Bucket the rows by `appointmentId`, so two different bookings can never merge. A row with no appointment becomes its own bucket rather than pooling with every other orphan.
2. Sort each bucket by start time, because the rows arrive from Prisma and from API payloads in no guaranteed order.
3. Split the bucket wherever `prev.endsAt !== next.startsAt`, so a gap between two sittings ends the run.
4. Split it again wherever `isTentative` changes, because an unallocated placeholder is not part of the confirmed session sitting next to it.

Rows that `isDeadSlot` rejects — `completionStatus` in `{CANCELLED, RESCHEDULED}` **or** a non-null `deletedAt` tombstone — are dropped before any of this happens. They can never be joined, and leaving them in would let a dead row bridge two runs that are not actually contiguous. Callers that do not select `deletedAt` still degrade safely (`undefined` is treated as live for that signal alone).

The run's first row is its **anchor**, and it is the only row anything may be keyed to.

### Why the Walk Exists Rather Than Keying on `appointmentId`

One appointment per session is the designed model, and the allocator enforces it on every path that creates a booking. It is not, however, enforced by the schema, and it was historically violated in two places. `prisma/seedFiles/6a-create-appointments.ts:368` attaches weeks-apart sessions to a single appointment (seed-only). The planner webinar/class path used to write one long slot or move only `appointmentOccurrences[0]` (#1071).

**Planner create** for both webinars and classes now goes through `lib/appointments/occurrences.ts` (`buildContiguousSlotAtoms`) and writes a contiguous N×30min run. **Planner PATCH** differs by type: webinar `crud-with-plan` rewrites the live run via `replaceContiguousSlotRun` (in-place reconcile — update overlapping ids, create the delta, soft-retire surplus as `RESCHEDULED` — so `Meeting` / `Recording` cascades are not tripped). Class `crud-with-plan` PATCH does **not** rewrite slot times when `sessionDurationInHours` changes; allocated class sessions keep their existing run length until a future allocator/reschedule path moves them.

If sessions were keyed on `appointmentId` alone, both of those cases would collapse unrelated sessions into one shared video room. That is a cross-session privacy leak rather than a cosmetic defect, so the contiguity walk is load-bearing and must not be simplified away.

### What Follows From a Run

Three things derive from runs and never from individual rows.

- **Room identity.** The Stream call is keyed to `slot-<anchorSlotId>`, so both sides of a booking resolve the same room from whichever row their surface happened to hand over. Keying on the clicked row is #1061: a one-hour booking had capacity for two rooms and the two parties could each sit alone in one.
- **Join state.** The join window, and the check for a call the host has already ended, are both measured over `[run.startsAt, run.endsAt]`. Measured per row, a two-hour class stops being joinable thirty minutes in.
- **The session count and label.** A four-hour booking is one session running 12:30 to 16:30, not eight half-hour sessions of which the list shows the first. The same applies to "sessions this week", progress text, and anything else that counts.

## The Join Gate

Whether a person may open the video room for a booking is decided by three independent questions, and every surface that renders a Join affordance must ask all three. They live in `lib/appointments/occurrences.ts` and `lib/appointments/status.ts` so that no page has to answer them for itself.

### Is the session inside its window?

`getSessionJoinState(run)` answers this over the whole run, never over a single row. It returns one of four values. A `countdown` session has not opened yet, a `joinable` one is open now, an `ended` one is over, and a `disabled` one is a tentative placeholder or a dead row that can never be joined at all. The window itself is a role-dependent lead time before the session starts, and there are exactly two of them.

| Constant                    | Value      | Who it applies to                                                         |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `CONSULTEE_JOIN_WINDOW_MS`  | 10 minutes | Learners, on every consultee and organization-member surface.             |
| `CONSULTANT_JOIN_WINDOW_MS` | 15 minutes | Hosts, so that they can be in the room before the first attendee arrives. |

Both constants are exported from `lib/appointments/occurrences.ts` and every caller imports one of them. Declaring the value locally is what #1270 removed: six surfaces had each written their own, landing on four different answers, so the same booking opened at four different times depending on which page the user happened to be looking at. The planner in particular gave a host a ten-minute window while the appointments list beside it gave the same host fifteen.

An `ended` session is not merely one whose clock has run out. When the host closes the call, the `Meeting` row records `endedAt`, and from that moment the session is over even though its slot rows still run for another forty minutes. Any surface that compares only `startsAt` and `endsAt` will keep offering Join for the rest of the booked hour and will drop whoever clicks it into a fresh, empty room. That is the defect `getOccurrenceVMJoinState` exists to prevent for the mapper-emitted `OccurrenceVM` rows that the session timeline renders.

### Is the booking confirmed?

An open window is a statement about the clock, not about the booking. `isConfirmedStatus(status)` is the second half of the gate, and it admits only `APPROVED`, `SCHEDULED` and `IN_PROGRESS`. It therefore refuses a booking still at `APPROVED_PENDING_PAYMENT` or `AWAITING_PAYMENT`, where the slot is held but nobody has paid, and it refuses the terminal states, where the session has already been closed out or called off. Both sides of a booking use the same predicate, which is what #1270 restored: the consultee adapter had always required it while the consultant adapter tested only that the row was not in the cancelled bucket, and the consultant home tab tested nothing at all.

### Is the surface allowed to hand over a join handler?

The third question is asked by the adapter, not by the shared helpers. A read-only surface renders the timeline without an `onJoinSession` callback, and a session that is live but whose booking the adapter has refused must then read as a state rather than as an action. `SessionTimeline` (the appointment sheet) and `SessionSchedule` (the detail page) render the Join button only when a handler is present and show a muted, non-actionable label otherwise, because a row that says "JOIN" in unmuted text and does nothing when clicked is worse than one that says nothing at all.

### The development escape hatch

`NEXT_PUBLIC_ENABLE_DEV_TOOLS` is the single flag that opens the force-join backdoor, and it is opt-in: `.env.sample` ships it as `"false"`. Keying the backdoor off `NODE_ENV` instead means it is open on every local run whether or not the developer asked for it, which is why #1270 standardised the surfaces that did so.

The backdoor is always **additive**. It adds a separately labelled "Join (Dev)" affordance in the places where the real Join is absent; it never relaxes, re-labels or un-disables the real one. The consultant home tab used to do exactly that — the dev arm _was_ the gate — with the side effect that every genuine Join on a development build was mislabelled as a dev join.

## Week Boundaries (Sunday-Saturday)

All week-based calculations use **Sunday as the first day** of the week.

### `startOfWeekSunday(date)`

Returns the Sunday at 00:00:00 of the week containing the given date.

```
Input: Wednesday Jan 15, 2025
       day = 3 (Wednesday)
       diff = 3 (days since Sunday)
Output: Sunday Jan 12, 2025 00:00:00
```

### `countWeeks(startDate, endDate)`

Counts distinct Sunday-start weeks overlapping the date range [start, end].

**Algorithm**:

1. Normalize both dates to midnight
2. Find the Sunday of start week and end week
3. Count Sundays from start to end inclusive

```
Example: Jan 1 (Wed) to Feb 1 (Sat)
  Start Sunday: Dec 29
  End Sunday:   Jan 26
  Weeks: Dec 29, Jan 5, Jan 12, Jan 19, Jan 26 = 5 weeks
```

```mermaid
gantt
    title Week Boundaries Example (Jan-Feb)
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Weeks
    Week 1 (Dec 29 - Jan 4)   :w1, 2024-12-29, 7d
    Week 2 (Jan 5 - Jan 11)   :w2, 2025-01-05, 7d
    Week 3 (Jan 12 - Jan 18)  :w3, 2025-01-12, 7d
    Week 4 (Jan 19 - Jan 25)  :w4, 2025-01-19, 7d
    Week 5 (Jan 26 - Feb 1)   :w5, 2025-01-26, 7d

    section Date Range
    Start (Jan 1)              :milestone, 2025-01-01, 0d
    End (Feb 1)                :milestone, 2025-02-01, 0d
```

### Why not `durationInMonths * 4`?

The hardcoded `* 4` approximation is wrong for anything beyond short durations:

| Duration  | `* 4` result | `countWeeks()` result | Error |
| --------- | ------------ | --------------------- | ----- |
| 1 month   | 4 weeks      | 4-5 weeks             | 0-1   |
| 3 months  | 12 weeks     | 13-14 weeks           | 1-2   |
| 6 months  | 24 weeks     | 26-27 weeks           | 2-3   |
| 12 months | 48 weeks     | 52-53 weeks           | 4-5   |

Always use `ScheduleCalculationService.countWeeks()`.

## Total Slots Required

**`calculateRequiredSlots(eventType, config)`**:

| Event Type   | Formula                                                                       | Example                                             |
| ------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Consultation | `Math.ceil(durationInHours / 0.5)`                                            | 1.5h = 3 slots                                      |
| Webinar      | `Math.ceil(durationInHours / 0.5)`                                            | 2h = 4 slots                                        |
| Subscription | `countWeeks(start, end) * sessionsPerWeek * Math.ceil(sessionDuration / 0.5)` | 5 weeks, 2/week, 1h sessions = 5 × 2 × 2 = 20 slots |
| Class        | `countWeeks(start, end) * sessionsPerWeek * Math.ceil(sessionDuration / 0.5)` | Same formula                                        |

## Consecutive Slot Validation

**`validateConsecutiveSlots(slots)`** in `ScheduleValidationService`:

1. Sort slots by time
2. For each adjacent pair: check `|current.time - (prev.time + 30min)| <= 1 second`

The **1-second tolerance** accounts for floating-point precision and timezone round-trip artifacts.

```mermaid
flowchart LR
    subgraph Consecutive
        A1["10:00"] --> A2["10:30"] --> A3["11:00"]
    end

    subgraph "Gap (invalid)"
        B1["10:00"] --> B2["10:30"]
        B3["11:30"]
        B2 -. "60-min gap" .-> B3
    end

    subgraph "Overlap (invalid)"
        C1["10:00"] --> C2["10:15"]
        C2 -. "15-min overlap" .-> C1
    end
```

## Grouping Functions

### `dayKey(date, timeZone?)` and `weekKey(date, timeZone?)`

These two helpers are the canonical bucketing keys for every daily and weekly limit (ADR B9). Both return `YYYY-MM-DD` calendar dates evaluated in the event's scheduling timezone — `dayKey` the date containing the instant, `weekKey` the date of the Sunday that starts its week. The timezone defaults to `ScheduleCalculationService.DEFAULT_SCHEDULING_TIMEZONE` (Asia/Kolkata) and is overridden by the event's `schedulingTimezone` column. The client's interactive guards, the auto-allocation algorithm, and the server validators all bucket with these keys, so their verdicts cannot diverge by machine timezone. `startOfWeekSundayInTz(date, timeZone?)` returns the same week boundary as a UTC instant for code that needs Date ranges (the weekly-info generator).

### `groupSlotsByDay(slots, timeZone?)`

Groups slots by `dayKey(startTime, timeZone)`. Returns `Map<string, TimeSlot[]>`.

Used by: daily call limits (subscription), session count (class), completed-calls counting.

### `groupSlotsByWeek(slots, timeZone?)`

Groups slots by `weekKey(startTime, timeZone)`. Returns `Map<string, TimeSlot[]>`.

Used by: weekly distribution validation, weekly limit checks.

## Progress Calculation

**`calculateProgress(selectedSlots, eventType, config)`**:

For one-time events (consultation, webinar):

- `scheduled = selectedSlots.length >= slotsPerCall ? 1 : 0`
- `required = 1`

For recurring events (subscription, class):

- `scheduled = countCompletedCalls(selectedSlots, slotsPerCall)`
- `required = countWeeks(start, end) * sessionsPerWeek`

**`countCompletedCalls`** groups slots by day, sorts within each day, and counts complete consecutive groups of `slotsPerCall` slots. It counts **calls** (complete session groups), not individual slots.

Example: 2 slots/call, day has slots at [10:00, 10:30, 14:00, 14:30]

- Group 1: 10:00 + 10:30 = 1 complete call
- Group 2: 14:00 + 14:30 = 1 complete call
- Result: 2 completed calls

## Auto-Expansion (Consecutive Slot Selection)

When a user selects the first slot of a multi-slot session, the frontend auto-selects the remaining consecutive slots.

```mermaid
flowchart TD
    A[User clicks slot at 10:00] --> B{slotsPerSession > 1?}
    B -->|No| C[Select single slot]
    B -->|Yes| D[Check next N-1 adjacent slots]
    D --> E{All available and not booked?}
    E -->|Yes| F[Auto-select all N slots]
    E -->|No| G[Select only clicked slot, show warning]
```

This feature applies to all event types where `slotsPerSession > 1`. Implementation is in `useScheduling.ts` within the `toggleSlot()` function.

## Duration Validation

**`validateDuration(duration, fieldName)`** is a safety gate called before any division or loop:

- Must be defined (not undefined/null)
- Must be a number
- Must be positive (`> 0`)
- Must be finite
- Must be >= 0.5 hours (30 minutes)
- Warns if > 24 hours (unusual but not blocked)

This prevents division-by-zero, infinite loops, and negative slot counts in `calculateRequiredSlots` and `getSlotsPerCall`.

## Availability windows are contiguous, and validation is a union (#1320)

A consultant's published availability is stored as one `AvailabilityWindowWeekly` row per contiguous window, up to the twelve-hour bound that `isValidTimeRange` enforces on a single row, beyond which the fold starts a new row and the booking still spans both through the union check described below. Every save path merges exactly-adjacent same-day rows before writing, so an entry of "3:30–4:30" followed by "4:30–5:30" lands as one "3:30–5:30" row, and a one-off script folds rows that already exist. The booking generator merges consecutive available atoms regardless of which row produced them, and checkout validates a booking window by requiring that every thirty-minute atom of the window falls inside some published row, weekly or custom, rather than inside the single row the client named. The named row id still proves ownership and catches a soft-deleted profile, but it is no longer the boundary of what can be booked. This is what makes a two-hour plan bookable inside a two-hour block that the expert page draws as one, which was not the case while the generator and checkout were row-bound.

## Projecting a weekly row onto real dates

A weekly availability row is a rule, not an event: it says that the consultant is free on a named local day between two wall-clock times in a named IANA zone, and the concrete instants it produces have to be computed for whatever date range a surface is drawing. The rule lives in the row's five local columns (`timezone`, `localStartDay`, `localStartMinutes`, `localEndMinutes`, `localEndDay`), and the instants are materialised one local date at a time through the zone's own DST rules.

`utils/schedule/weekly-projection.ts` is the one place that does it. `weeklyRowIntervalsInRange(row, rangeStart, rangeEnd)` walks the local dates covering the range, starting one day early so an overnight occurrence that began before the window keeps its tail, and for each date whose weekday is `localStartDay` resolves the local start and end to UTC. A New York Monday 09:00–12:00 row is therefore 14:00Z–17:00Z on 2 March 2026 and 13:00Z–16:00Z on 9 March, the day after the clocks change. A local time that does not exist on a spring-forward date is skipped for that date, and a time that occurs twice on a fall-back date takes its first occurrence. `isInstantWithinWeeklyRow` asks whether one occurrence contains a window, and `createWeeklyCoverage` answers the same question for many windows by projecting each UTC week once. The module imports only `date-fns-tz` and a type from Prisma, so the grid, the allocator, the jsdom tests and the client bundle all share it.

Every consumer goes through it and they must never diverge. `processWeeklySlots` (`utils/scheduling-engine/intervals.ts`) generates the calendar grid, `findAvailableSlots` (`lib/booking/allocation/search/find-available-slots.ts`) generates the allocator's candidates, and checkout, the validator and the co-host filter test atoms through `createWeeklyCoverage`. The rule to hold onto when changing any of them is that the grid must offer only atoms the validator accepts; `__tests__/booking-algorithm/weekly-day-semantics.test.ts` and `__tests__/scheduling/weekly-dst-projection.test.ts` assert it, including across the New York, London and Sydney transitions. See `docs/booking/19-dst-and-timezone-posture.md` for what the save path writes.

Segmenting those occurrences for display no longer cuts a block at local midnight. `breakDownSlotsByDuration` (`utils/scheduling-engine/intervals.ts`) snaps window starts to the absolute UTC half-hour and `groupSlotsByDate` keys each window by the viewer day of its own start, so :45 zones keep every atom; a fetch range ends at the next day's first instant (`dayRangeBounds`), so a block that runs to midnight keeps its final 23:30 atom (#1415).

Merging is the last step, and its rule is exact adjacency in both of the places that merge. `mergeConsecutiveSlots` joins the booking-side atoms and `mergeConsecutiveSlotsForDisplay` (`app/explore/experts/[consultantId]/utils/mergeSlots.ts`) joins the expert page's; the only difference between them is which atoms are eligible, since the first merges available atoms only and the second merges any run that shares a status. Neither tolerates a gap. A tolerance on the display side advertised a window whose seam no availability row publishes, and checkout's per-atom union coverage then refused the booking the card had just promised (#1416).

## Projecting a custom row onto the allocator's days

A custom availability row is not a rule but an absolute instant range, `startsAt` to `endsAt`, and nothing bounds it to one day: rows coalesce on adjacency or overlap, so a consultant who publishes back-to-back days ends up with one row that spans all of them. Checkout and the validator test each thirty-minute atom for containment in some row, so a long row is fine for them. The availability grid (`availability-with-allocation`) passes every overlapping row to `processCustomSlots`, which clips it to the requested range, and keys each atom by the viewer day its own start falls on, so a Friday-to-Monday row paints Friday evening, Saturday, Sunday and Monday morning. The allocator's auto search does care, because it walks the scheduling period one day at a time and needs to know which availability each day can offer.

`customRowDaySlices` (`lib/booking/allocation/search/recurrence.ts`) answers that by cutting a row into one slice per calendar day of the plan's `schedulingTimezone` (the zone its daily and weekly caps are counted in, `Asia/Kolkata` when the plan has none). Each slice runs from that day's first instant to the next day's first instant (`dayStartInstant`, the exclusive bounds `dayRangeBounds` in `lib/time/grid-zone.ts` returns), clipped to the row's own start and end. A row inside one zone day is returned whole without the cut search. The cuts are rounded up to the UTC half-hour lattice, so an atom belongs to the day its start falls on: in Kathmandu (+05:45) Sunday begins at 18:15Z on Saturday, and the 18:00Z–18:30Z atom, which starts at 23:45 on Saturday, stays in Saturday's slice instead of falling between two. A London fall-back Sunday is a single 25-hour slice (≤ 25 h holds in every inhabited zone), which is why the per-row ceiling `MAX_CANDIDATE_STARTS_PER_ROW` is 50.

`customSpansInStartOrder` clips every row to the walk's window, then yields the slices in start order. The recurring sweep in `findAvailableSlots` uses the scheduling period as the window, so a row begun before the period still offers its in-period tail; it slices every row in the period up front and files each slice under the UTC day it starts on, the same filing the weekly occurrences use, so its cost is bounded by the period rather than by the first fit. The single-session walk for consultations and webinars (`bestBlockForSingleSession`) uses the weekly arm's horizon (8 weeks for a consultation, 4 for a webinar), so a long coalesced row cannot place a consultation further out than a weekly row could, and consumes the slices lazily, so a row is cut only once that walk reaches it and a first fit stops the slicing. Those events carry no `schedulingTimezone` and slice in the default `Asia/Kolkata`; the zone only sets the walk's granularity, not which blocks are found, because a block is checked against the merged availability index and may span a slice cut by design. A Friday 18:00 to Monday 10:00 row in Asia/Kolkata therefore offers Friday evening, the whole of Saturday and Sunday, and Monday morning, and a subscription that wants three sessions a week still keeps a free day where it can (Friday and Sunday) before it packs (Saturday). The lead time, the daily cap and the spacing preference are applied per candidate exactly as for a weekly row. `__tests__/booking-algorithm/custom-row-day-slices.test.ts` pins the Kolkata, Kathmandu and London cases.

## Deprecated & Superseded Approaches

- **Dropping custom rows longer than 24 hours from the grid.** The grid route discarded any custom row over 24 hours as "unreasonable", so a coalesced multi-day row drew an empty grid while the allocator placed sessions in it. The cap is gone; the range clip bounds the work.
- **Matching a custom row on its start day only.** `matchCustomSlotToDay` offered a custom row only on the UTC day of its `startsAt`, and the row walk stopped after 48 starts, so a multi-day row offered its first 24 hours and nothing else, and a row that began before the scheduling period offered nothing at all. Replaced by `customRowDaySlices` above.
- **`splitSlotsByDay` for display.** It cut each generated block into half-open segments at the viewer's local midnight, which pushed :45-zone viewers off the half-hour lattice. Deleted; windows are keyed by their own start's viewer day.
