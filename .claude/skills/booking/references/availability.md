---
name: booking-availability
description: How a consultant's published availability becomes bookable slots — weekly versus custom rows, the scheduleType discriminator, coalescing on save, the 30-minute atom, union coverage validation, the grid endpoint, the occupancy and dead-hold rules, and the three allocation modes with partial allocation and the collaborator guard. Load when working on availability rows, the booking calendar grid, slot generation, conflict detection, or anything under utils/scheduling-engine/, app/api/scheduling/, or the allocate routes.
---

# Booking Availability

Availability is stored as coarse rows, published through one of two mutually
exclusive modes, generated into 30-minute atoms for display, and validated back
against the union of those rows at write time. Most bugs here are a
disagreement between two of those four stages.

## 1. Weekly xor custom — the `scheduleType` discriminator

`ConsultantProfile.scheduleType` is a non-nullable `enum ScheduleType { WEEKLY,
CUSTOM }` with no default, so a consultant publishes in exactly one mode. Both
relations exist side by side, so rows from the dormant mode can persist from a
previous schedule — which is why every reader must gate on the discriminator
rather than unioning both tables.

`AvailabilityWindowWeekly` rows mean "this local wall-clock window, every week,
in this IANA zone", and every reader projects them from their five local columns
alone: `timezone`, `localStartDay`, `localStartMinutes`, `localEndMinutes` and
`localEndDay`. `weeklyRowIntervalsInRange` (`utils/schedule/weekly-projection.ts`)
resolves each local date through the zone's rules, so the instants move across
DST while the wall clock stays put; a spring-forward local time is skipped for
that date and a fall-back one takes its first occurrence. A row with NULL local
columns is refused by every reader (`partitionWeeklyRows`) and reported once per
call (`reportIncompleteWeeklyRows`). The UTC columns (`startDay`, `endDay`,
`startTimeUtc`, `endTimeUtc`, `utcOffsetMinutes`) are still written for the
overlap SQL, but nothing projects through them. Writers derive the local columns
with `weeklyLocalColumnsForSave` (`lib/scheduling/weeklyUtcOffset.ts`), which
adds back the zone's offset on the editor's 1970-01-01 probe date, and a zone
whose offset is off the 30-minute grid (UTC+05:45) is refused with `ZONE`. See
`docs/booking/19-dst-and-timezone-posture.md`.
`AvailabilityWindowCustom` holds date-specific rows as `startsAt`/`endsAt` and
has no `isAvailable`, so a custom row is purely additive and can never express a
blackout. Neither model has a `deletedAt` column: removing a weekly or custom
row is a hard delete (the per-row DELETE routes and the coalescing pass in
`mergeAdjacentWeeklyRows.ts`), so a reader never has to filter a tombstone and
history lives in `Appointment` and `AppointmentOccurrence`, not in availability
rows.

## 2. Rows coalesce on save

As of wave 5 (#1323), `utils/scheduling-engine/mergeAdjacentWeeklyRows.ts` folds
adjacent rows on every availability write, across all four write routes under
`app/api/scheduling/availability/` (`weekly`, `weekly/[id]`, `custom`,
`custom/[id]`). Each of those routes runs its overlap check, its write and the
coalescing pass inside **one** Serializable transaction under
`withSerializableRetry`, so the check-then-act window is closed and the row ids
the response returns are the post-merge ones. Despite the file name the module
covers both modes, and the two rules differ because the row shapes do.

Weekly rows merge on their local columns: only on exact adjacency, only within
one zone and one local day, and never when either row crosses local midnight; a
row without local columns is left alone. `coalesceConsultantWeeklyRows` deletes
and recreates, so every weekly row id changes, and it carries every column
across, local ones included.

Custom rows merge on adjacency **or overlap**, keeping the later `endsAt`, and
`coalesceConsultantCustomRows` preserves the surviving row's id, deleting only
the folded rows, because a booking names a custom row. That asymmetry is
load-bearing; do not "simplify" it.

Both folds stop at `MAX_DURATION_MINUTES` (`utils/scheduling-engine/interval-validation.ts`, twelve
hours). A merge that would cross that bound starts a new row instead, because
`isValidTimeRange` rejects anything longer and the settings loader filters its
rows through that validator — a thirteen-hour merged row would vanish from the
form and the next save would delete it.

## 3. Checkout validates against the union of rows, atom by atom

Every slot is uniformly 30 minutes (ADR B1), but there is no single canonical
constant, and the copies are **not interchangeable**: they are declared under
at least eight names and fall into three genuinely different behaviours, plus a
fourth category that is not an atom at all. Read the table before assuming two
of them can be swapped.

| Declaration                                                                            | File                                                                                                                                                                                      | Behaviour                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLOT_GRID_MS`                                                                         | `lib/payments/utils/slot-validation.ts`                                                                                                                                                   | **Rejects off-grid.** `slotStartRefusal` refuses a client-picked start with `SLOT_NOT_ON_GRID` when `start % 30min !== 0`. The only place 30 minutes is a constraint _on a timestamp_.                                                         |
| `SLOT_ATOM_MS`                                                                         | `utils/appointmentlock.ts`                                                                                                                                                                | **Floors to the grid.** `Math.floor(startsAt / SLOT_ATOM_MS) * SLOT_ATOM_MS`, then steps. Deliberately a superset: a `:15` start takes both the `:00` and `:30` atoms, so two writers can never hold disjoint keys for the same booked minute. |
| `ATOM_MS`, `slidingIntervalMillis`, `SCHEDULING_INTERVAL_MS`, `SLOT_MS`, `thirtyMinMs` | `utils/scheduling-engine/availabilityCoverage.ts`, `utils/scheduling-engine/intervals.ts`, `lib/appointments/occurrences.ts`, `schemas/appointments.ts`, `lib/booking/allocation/search/` | **Steps from an arbitrary anchor.** Never consults the epoch — it steps from whatever start it is handed, so a window opening at `:15` yields `:15`/`:45` atoms.                                                                               |
| `THIRTY_MIN_MS`                                                                        | `utils/scheduling-engine/intervals.ts`                                                                                                                                                    | **Not an atom.** Used only as a `Math.floor(ms / X)` _bucket divisor_ for index keys in `buildAppointmentIndex` and in `lib/booking/overlap-meta.ts`. It has no window semantics, so "the atom" is the wrong name for it.                      |
| `intervalDurationMs`                                                                   | `utils/scheduling-engine/interval-meta.ts`                                                                                                                                                | **A duration, not a grid.** The "is this 30-minute interval already full?" threshold.                                                                                                                                                          |

Only the exported `SCHEDULING_INTERVAL_MS` (`lib/appointments/occurrences.ts`) and
`THIRTY_MIN_MS` (`utils/scheduling-engine/intervals.ts`) are importable, and
neither is the one you usually want. The rest are module-private. Do not add a
ninth, and do not "consolidate" by pointing one call site at another: the
difference between flooring and anchoring is load-bearing in both
`appointmentlock.ts` and `availabilityCoverage.ts`.

`utils/scheduling-engine/availabilityCoverage.ts` is the write-time gate.
`windowAtoms(start, end)` chops the half-open window into atoms and
`findUncoveredAtom` returns the first atom that **no** row covers, so no single
row need cover the whole window — coverage is per-atom across the union.
`loadPublishedCoverage` makes "published" concrete: it reads `scheduleType` and
returns weekly rows only in WEEKLY mode and custom rows only in CUSTOM mode,
never querying the dormant arm, so a stale row from a previous schedule mode
cannot cover an atom no surface offers. It also **fails closed** on the profile
itself — a missing or soft-deleted `ConsultantProfile` returns
`{ scheduleType: null, weeklyRows: [], customRows: [] }`, so a deleted expert
publishes nothing whatever rows survived the deletion. As of wave 5 (#1323)
exactly two callers enforce this inside their transaction: checkout
(`revalidateInsideLock` in `lib/payments/checkout/revalidate.ts`), and the trial route
(`app/api/trials/[trialId]/route.ts`), which throws
`OutsideAvailabilityWindowError` even when the consultant is the one scheduling,
because a trial is a booking.

The display path matches: `mergeConsecutiveSlots` (`utils/scheduling-engine/intervals.ts`)
joins free slots on **exact** adjacency — the merged end is the next start — and,
as of #1320, **across** availability rows, accumulating every covering id into
`availabilityWindowIds` (the first row's id also stays on the slot alone as
`availabilityWindowId`, for compatibility). Merging across rows was forbidden until union validation
replaced the single-row-id check, and the old ±60 s tolerance had to go with it:
rows ending 10:30 and starting 10:31 would otherwise be offered as one window
whose 10:30 atom no row publishes, which checkout's union coverage then rejects.

## 4. Generation and the grid endpoint

`ScheduleCalculationService` is a static date and duration utility, **not** the
generator. Generation happens in two places that must agree:
`processAvailabilitySlots` (`utils/scheduling-engine/intervals.ts`) for the grid and the
`findAvailableSlots` (`lib/booking/allocation/search/find-available-slots.ts`) for the allocator.

What makes them agree is that both project weekly rows through the same
generator, `weeklyRowIntervalsInRange` (`utils/schedule/weekly-projection.ts`),
which walks the range one local date at a time, starting a day early so an
overnight row keeps the tail that falls inside it. Checkout, the validator and
the allocator test atoms through `createWeeklyCoverage`, built on the same
generator — the invariant is that the grid offers only atoms the validator
accepts, pinned in `__tests__/booking-algorithm/weekly-day-semantics.test.ts`
and `__tests__/scheduling/weekly-dst-projection.test.ts`. The auto-allocator may
place a session in the post-midnight tail of an overnight row, provided that
day's and week's caps still have room.

Segmentation and merging carry two more boundary rules. `processAvailabilitySlots`
does not cut a block at the viewer's midnight: `breakDownSlotsByDuration` snaps
each window start up to the absolute UTC half-hour lattice and keys the window by
the viewer day its own start falls on (`dateInISO`, `dayOfWeek`), so a block that
crosses midnight keeps every atom and a viewer in a :45 zone (Kathmandu, Eucla)
sees on-lattice cells. Both merge functions
— `mergeConsecutiveSlots` for booking and `mergeConsecutiveSlotsForDisplay`
(`app/explore/experts/[consultantId]/utils/mergeSlots.ts`) for the expert page —
require exact adjacency, and differ only in which atoms are eligible; a
tolerance on either side advertises a seam no row publishes (#1416).

The grid is `GET /api/scheduling/availability-with-allocation/[consultantId]` with
`startDateInUtc`, `endDateInUtc` and `timezone`, public in `middleware.ts`. The
expert page asks for `zonedWeekWindow` bounds — viewer-zone local midnight to the
local midnight seven days later, end exclusive — so the week's last 23:30 atom is
inside the window; the dashboard grid's `dayRangeBounds` (`lib/time/grid-zone.ts`)
is end-exclusive the same way.
Both grids poll it, so a stale tab self-corrects. The consultee's expert-page
queries (`useAvailabilityWindow`, `useAvailabilityMonth`) poll every 60 s plus
jitter while the tab is visible, refetch on focus, back off to 5 minutes after
three failed polls in a row, and send the ETag so an unchanged poll is a 304
(`createGridPollInterval` in `lib/scheduling/availabilityPolling.ts`). The
allocator's calendar (`hooks/scheduling/useCalendarData.ts`) polls on the same
60 s cadence through `createAvailabilityPoller`, paused while the tab is hidden
and refetched on a stale return. Freshness stays a user-experience
concern (ADR 16, `docs/enterprise/70-design-decisions/16-slot-freshness-without-realtime.md`):
checkout's recheck under the slot lock is the only correctness mechanism, and a
taken slot answers 409 `code: "SLOT_TAKEN"`, which returns the buyer to a
refetched grid with "That time was just taken — pick another."

The ETag (`lib/scheduling/availabilityGridMarker.ts`) folds in more than the
rows, because three things change a cell without any row changing: the earliest
live hold's `expiresAt` (`nextHoldExpiry`), so a hold that lapses by the clock
changes the tag; the lead time and its bucket (`leadMs`, `leadTimeBucket`), so a
cell that enters the lead time, or a grid drawn for another purpose, changes it;
and, when the overlay is asked for, the subscription quota fold.

The route also returns per-cell flags the client paints as their own
non-selectable states. The caller names the writer it draws for with
`?purpose=book|request|allocate|reschedule` (default `book`) and `&unpaid=1`,
and the route applies that writer's lead time from `leadMsFor`
(`lib/booking/lead-time.ts`, §6): a cell whose start is at or before
`now + leadMs` is "Too soon", the same boundary the writers refuse. The body
carries a top-level `leadMs`, and the client re-applies it between polls
(`isTooSoonAt` in `lib/scheduling/week-grid-model.ts`), so a cell flips to
"Too soon" on the clock without waiting for the next poll. With `subscriptionId`
(and optionally `releasing`, the occurrence ids a reschedule is moving, which
count as released) it adds the **quota overlay**: a `GridQuota`
(`lib/scheduling/grid-quota.ts`) with the cycle `unit`, `capacity`, the open plan
week as `weekNumber` of `weekCount`, `filled`, `remainingThisCycle`, `allBooked`,
the exclusive `windowStart`/`windowEnd`, the fixed `planEndsAt`, the per-day cap
and the `fullDays` already at it. Cells before the open plan week, in a full open
week, on a full day, or at or after the plan end paint "Limit reached", and the
footer reads "Week 3 of 26 · 2 of 3 booked" (or "Week 4 of 26 is set · next
opens Mon 16 Mar"). The overlay is authorized and folded before the conditional
GET, so a 304 never serves it to a caller who has lost access. The fixed plan week
(§6) is the only
weekly counter; there is no Sunday-week cap on a subscription.

Host-cancelled class sessions keep their row (no `deletedAt`) for make-up and
refund accounting, so every occupancy reader filters occurrences through
`OCCUPYING_OCCURRENCE_WHERE` (`utils/scheduling-engine/occupancyPolicy.ts`): live,
not host-cancelled, not `CANCELLED`. `RESCHEDULED` rows still occupy.

## 5. Occupancy, and when a hold is dead

`utils/scheduling-engine/occupancyPolicy.ts` answers "what blocks this slot".
`OCCUPIED_REQUEST_STATUSES` is `PENDING`, `APPROVED`, `APPROVED_PENDING_PAYMENT`
and `SCHEDULED`; `OCCUPIED_EVENT_STATUSES` is `SCHEDULED` and `IN_PROGRESS`;
trials occupy at `SCHEDULED` and `AWAITING_PAYMENT`, because a paid trial's slot
is reserved the moment the consultant accepts. `buildConsultantOccupancyWhere`
asks both questions the grid and allocator once asked separately: busy if
connected to a live slot **or** if the appointment runs under one of their
plans.

A hold that is no longer live must stop blocking, and the rule lives in two
places asserted to agree by `hold-expiry-predicate.test.ts`:
`isOccupiedByLiveAppointment` (`utils/scheduling-engine/ScheduleValidationService.ts`)
is the JS predicate, and `buildDeadHoldFilter` (`occupancyPolicy.ts`) is its SQL
twin, added in wave 5 (#1328) for callers that select slots and so cannot run
the predicate — checkout's first step and the trial route.

A payment row is **dead** when the sweep marked it `EXPIRED`, the gateway marked
it `FAILED`, or it is still `PENDING` past its `expiresAt` — never by the clock
alone, because a `SUCCEEDED` row keeps its `expiresAt` and must never free the
slot it paid for. The hold is free only when _every_ payment row is dead and
there is at least one; in Prisma that needs `some: {}` alongside `every`, since
`every` is vacuously true on an appointment with no payments. Two shapes
qualify: an `APPROVED_PENDING_PAYMENT` request, and — new in wave 5 (#1328) — a
`PENDING` request whose `bookingSource` is `DIRECT_CHECKOUT`, which never sees a
consultant approval and so stayed blocked until the sweep caught up. A `PENDING`
`REQUEST_SUBMITTED` request waits on a human, not a payment, and always
occupies.

## 6. Allocation modes, partial allocation, and the collaborator guard

There is one endpoint per event type — `PATCH
/api/bookings/{consultations|subscriptions|webinars|classes}/[id]/allocate` —
and the mode comes from the body, not the URL: `useRequestedSlots` wins, else
`isAuto` (a required field), else manual, which needs a non-empty `slots` array
of ISO datetimes. `AllocationMode` is the union `"auto" | "manual" |
"requested"` in `utils/scheduling-engine/types.ts`.

As of wave 5 (#1329), `allowPartial` lets the consultant say "place what fits
now, the rest later". It defaults to false, is honoured only for the event's
consultant or a privileged caller (`body.allowPartial === true && canOverride`),
reaches only the `auto` path, and applies only to recurring event types — a
consultation or webinar is one session, so it either fits or it does not. A
partial success returns `partial`, `placedSessions`, `requiredSessions` and
`unplacedSessions`; a refusal returns `SLOT_SHORTAGE` with `placeableSessions`
so the client can offer the partial option instead of a dead end. The consultee
learns of it through the Novu workflow `appointment-partially-scheduled`.

The allocator lives in `lib/booking/allocation/`. `allocate` (`allocate.ts`) routes to
one file per mode: `modes/auto.ts` (`autoAllocate`), `modes/manual.ts`
(`manualAllocate`) and `modes/use-requested.ts` (`useRequestedSlots`). Each mode file
takes its own locks and opens its own write transaction. The shared write steps
are in `commit/`, the slot search in `search/`, and the multi-tab and replay guards
in `guards.ts` and `idempotency.ts`.

Allocation goes through **one handler route** as of #1702:
`lib/scheduling/allocate-route.ts` carries the whole auth → limiter → Zod →
`allocate` → typed-error contract, and each of the four `PATCH …/allocate`
routes is a thin delegator that only resolves its own typed segment param. There
is no per-event-type copy of the allocate logic to drift out of sync.

A conflict on allocation answers one of a typed family, not a bare 409: `AllocationErrorCode`
carries, among others, `LOCK_CONTENTION` (Redis lock busy or a replay in flight),
`ALREADY_ALLOCATED` (confirmed slots already exist; a second auto-allocate on an
allocated event is this 409), `RESCHEDULE_STATE_CHANGED` (the stale-tab case — the
tentative-slot count moved since the client loaded the page), `SLOT_TAKEN` (a chosen
time went to someone else mid-allocation), `TIMES_TAKEN` (a picked time is held
by another writer right now; the body names the taken times in the viewer's zone
and the other picks are kept), `ALLOCATION_RACE` (auto found no free set after
its re-searches; retryable), `SEARCH_TIMEOUT` (503, the auto search ran out of
time), `TOO_CLOSE_TO_START` (an unpaid approval whose first session starts too
soon to pay for), `CHECKOUT_IN_PROGRESS` (the buyer's own checkout is still
being paid), `PROPOSAL_AWAITING_CLIENT` (placing times over the consultant's own
open proposal that names times; withdraw it first, `resolveConsumedPreferenceRequests`
in `lib/booking/allocation/preference.ts`) and `SESSION_HAS_REMEDY`. The full union is `AllocationErrorCode` in
`utils/scheduling-engine/types.ts`. Conflict text names a time, never another
party. A client must branch on `errorCode`, never on the message wording: only
`ALREADY_ALLOCATED` closes the dialog and drops the row; every other code keeps
the dialog open and refetches the grid, because the underlying request is still
live and retriable.

Every session start obeys one lead-time contract, `leadMsFor(purpose, { settled })`
in `lib/booking/lead-time.ts`: `book` (an instant checkout) is 15 minutes;
`request` and `allocate` are 15 minutes once the booking is settled (paid or
free) and 2 hours while the client still has to pay; `reschedule` is 24 hours,
whoever moves it. `isTooSoonFor(purpose, ctx, startMs, nowMs)` is the one
boundary (a start at or before now plus the lead is too soon), used by checkout's
`slotStartRefusal`, the reschedule route and both asserts below; request-for-approval refuses a
priced request inside 2 hours with 409 `REQUEST_TOO_SOON` (`assertRequestLeadFits`);
an unpaid approval is refused by `assertUnpaidApprovalFits`. All three allocator
modes pass `leadMsFor("allocate", { settled })` into the search and the
validator, and the grid paints "Too soon" from the same function (§4). The
pre-lock overlap probe checks each chosen interval on its own, so an unrelated
session between two picks is not a conflict.

For a subscription the auto search first sweeps with spacing: it keeps a free
day between sessions (placed now or already held), so a week of 3 lands
Mon/Wed/Fri rather than Mon/Tue/Wed. The unconditional earliest-fit sweep after
it reconsiders everything the spaced sweep declined, so spacing never costs a
placement (`isSpacedFrom` in `find-available-slots.ts`).

A custom row is an absolute range and may span several days (rows coalesce on
adjacency, so back-to-back days fold into one row). The auto search walks it as
one slice per day of the plan's `schedulingTimezone` (`customRowDaySlices` in
`lib/booking/allocation/search/recurrence.ts`): each slice runs from that day's
first instant to the next day's (`dayStartInstant`, the exclusive bounds
`dayRangeBounds` uses), clipped to the row, with the cuts rounded up to the UTC
half-hour lattice so a :45 zone's atom across midnight stays on the day it
starts. Every covered day is a candidate under the same spacing, daily cap and
lead time. `customSpansInStartOrder` clips rows to the walk's window first (the
recurring period, or the single-session horizon of 8 weeks for a consultation
and 4 for a webinar, the same as the weekly arm) and yields the slices in start
order, so a row begun before the period still offers its in-period tail. The
recurring sweep files every slice in its period up front, so its cost is bounded
by the period; only the single-session walk consumes them lazily, so its first
fit stops the slicing. Consultations and webinars carry no
`schedulingTimezone`, so they slice in the default `Asia/Kolkata`; the zone only
sets the walk's granularity, not which blocks are found, because a block is
checked against the merged availability index and may span a slice cut. A
fall-back day's slice is 25 hours, the longest day in every inhabited zone,
which is why `MAX_CANDIDATE_STARTS_PER_ROW` is 50. The validator and the manual path judge custom rows by containment. The grid
route keeps custom rows of any length (it used to drop rows over 24 hours);
`processCustomSlots` clips each to the requested range and each atom is keyed
by its own viewer day.

A subscription is paced in fixed plan weeks (`subscriptionEntitlement` in
`lib/booking/entitlement.ts`). Week k is `[day0 + 7k, day0 + 7k + 7)`, where
`day0` is the plan start's zone-day in `schedulingTimezone`. The open week is the
current plan week, or the next one as soon as the current one is full, never
further; `nextBatch` is `sessionsPerWeek` minus the sessions held in that week,
bounded by what remains. Delivery does not gate the next week. `cycle.count` is
the number of plan weeks to the plan end and `cycle.ordinal` the zero-based open
week; `planWeekNumber`, `planWeekStartsAt` and `rescheduleWindow` are exported
for copy, reminders and the reschedule picker. Copy reads "Week N of W"
(`subscriptionCycleHeading`, the grid footer).

The top-up sweep (`topUpIncompleteEvents` in
`scripts/appointments/reconcile-occurrence-availability.ts`) retries a short
recurring event when its consultant changed availability since the last attempt
or when that attempt is at least 6 hours old (`TOP_UP_RETRY_MS`), so a plan week
that opens on the calendar is filled without an availability edit. Changed
calendars go first (newest change first), then rested ones oldest attempt first,
still capped at 25 events and 60 seconds a run. A subscription is a candidate
only when its consultant scheduled the plan with Auto: every allocation writes
its placement on the approval's `BookingStatusHistory.reason` as a stable token
(`SCHEDULE_REASON` / `scheduleReason` in `lib/booking/allocation/schedule-choice.ts`,
parsed strictly, shown through `SCHEDULE_REASON_COPY`): `schedule:auto` /
`schedule:by-hand` only for the plan's first scheduling (derived on the server
from what the plan held before the run, never a client flag), `schedule:week-*`
for a later week, `schedule:top-up` for the sweep (`bySweep`) and
`schedule:reschedule` when released sessions are re-placed or a reschedule is
confirmed. `plansOnAuto` reads the newest plan-level token; a plan with none
(scheduled before tokens existed) counts as by hand. Other plans
get the week reminder, which links to the allocate page's one-tap "Auto-schedule
this week".

Also as of wave 5 (#1329), the co-host guard runs in **every** allocation mode:
`assertCollaboratorsFree` (`lib/booking/allocation/collaborators.ts`) calls
`assertCollaboratorsAvailableForWindows` (`lib/collaborators/availability.ts`)
from all three paths, short-circuits for anything that is not a webinar or
class, checks only `ACCEPTED` collaborators against live slots on a half-open
overlap, and throws `CollaboratorUnavailableError` → 409
`COLLABORATOR_UNAVAILABLE`. As of #1319 "live" means the shared occupancy
predicate rather than the tentative flag: the slot's appointment must be in an
occupying state and must not be a dead hold, so a co-host's live checkout hold
blocks an allocation even though its slot is still tentative. It was previously reachable from one route only, so
a class scheduled through the allocator could land on a time a co-host was
already busy (AE-2, #784).

## 7. Grid states, and how they are painted

`lib/scheduling/interval-status-tokens.ts` is the single status vocabulary the
dashboard heat map, the mobile day list, the trial picker and the legend
(`components/scheduling/SlotStatusLegend.tsx`) all read, so a swatch can never
document a paint the cells do not use. Every state carries a colour **and** a
non-colour cue (a pattern, a border style or an icon), so no two states differ
by hue alone, and every identifying border clears 3:1 against the white card.
`resolveSlotStatusKey` is the one place a cell's state is decided, in this
precedence order:

| Key               | Label          | Fill        | Non-colour cue               |
| ----------------- | -------------- | ----------- | ---------------------------- |
| `justTaken`       | Just taken     | rose-100    | strike-through               |
| `selected`        | Selected       | emerald-700 | check icon                   |
| `thisEvent`       | This booking   | indigo-200  | person icon                  |
| `rescheduling`    | Being moved    | orange-100  | dashed border, move icon     |
| `fullyBooked`     | Booked         | slate-300   | lock icon                    |
| `partiallyBooked` | Partly booked  | amber-100   | amber hatch; not selectable  |
| `unavailable`     | Unavailable    | transparent | closed hatch on the gridcell |
| `past`            | Past           | slate-50    | 50 % opacity                 |
| `outsidePeriod`   | Outside period | white       | slate hatch                  |
| `tooSoon`         | Too soon       | slate-100   | dotted border                |
| `limitReached`    | Limit reached  | slate-100   | cross-hatch                  |
| `available`       | Free           | emerald-100 | solid border                 |

"Just taken" outranks "Selected": a pick that the latest poll proves gone paints
"Just taken" for exactly one committed render, then is deselected and announced
(`useJustTaken` in `lib/scheduling/use-just-taken.ts`). The legend shows only
the states the grid painted this render (`legendKeysFor`); a buyer grid explains
four (`BUYER_LEGEND_KEYS`). Requested times are painted on the allocate grid as a
"Requested" outline (`REQUESTED_OUTLINE`), not as a state.

The week grid's layout is structure, not palette; `docs/calendar/allocate-heatmap-ux.md`
owns it. Rules an agent must keep:

- The grid is a continuous ruled canvas of 24 px half-hour rows (`WeekGrid.tsx`).
  Closed time is a hatch on the gridcell (`CLOSED_CANVAS`); the `unavailable`
  token itself stays paint-free.
- Rows are cropped by the "Open hours" window (`openHoursWindow` in
  `lib/scheduling/week-grid-model.ts`); never fold rows into strips.
- Busy and picked runs render as `aria-hidden` blocks from `buildGridBlocks`
  (`lib/scheduling/grid-blocks.ts`) over cells that keep their names, focus and
  `data-slot-*` attributes; cells carry no visible text.
- The click and the hover ghost share `expandToSession`; a click on a picked
  session removes the whole session (`splitIntoSessions`).
- Picks, meters, legend and actions live in `SessionTray`; facts about the plan
  live in `SchedulingContextBar`, never in stacked banners.

## 8. Per-day rows in the display zone

The grid draws per-day row lists in the display zone, never from a browser-local
`Date` (`lib/time/grid-zone.ts`). `dayRows` returns every 30-minute UTC atom
whose start falls on that calendar date in the zone: 48 on a normal day, 46 or 50
across an hour shift, 47 or 49 across a half-hour shift. Cells stay on the UTC
:00/:30 grid whatever the offset, so a viewer at UTC+05:45 reads "9:15–9:45"
labels, and the repeated fall-back hour is labelled "1:00 am (2nd)".
`cellInstant` and `dayStartInstant` resolve instants through the zone's rules.

The display zone is the viewer's profile zone when it is valid
(`resolveGridZone`), with a "Use my device's time zone" switch
(`components/scheduling/ZoneSwitch.tsx`) offered only when it would change
anything (`canSwitchToDeviceZone`). The grid labels the zone it shows times in.

## 9. The mobile day list

Below the `md` breakpoint a consultee picking times gets
`components/scheduling/MobileDayListPicker.tsx`, chosen by
`components/scheduling/TimePicker.tsx`: day chips over `DAY_LIST_DAYS` (14) days
and a list of times, built by `lib/scheduling/day-list.ts` from the same grid
endpoint, the same status tokens and the same quota overlay. It starts at the
plan's allowed window and pages through it, refuses a pick that overlaps another
pick or lands on a full day (`pickConflict`), and drops stale picks the same
"Just taken" way. It receives the picker policy's lead as `minLeadHours`
(`leadMsFor(policy.lead.purpose, …)`), so it offers no time the grid would paint
"Too soon". Each `TimePickerPolicy` (`components/scheduling/time-picker-policy.ts`)
carries a `lead`: allocate is `allocate`, unpaid from `AllocationRequest.settled`;
both reschedule policies are `reschedule` (24 h); rebook is `book`. A
subscription reschedule clamps the picker to `rescheduleWindow`
(`lib/booking/entitlement.ts`), the allocator's own window computed with the
moved sessions released, so a pick the auto-confirm would drop is never offered.

The expert page's slot list (`windowsForDay` in `lib/scheduling/booking-windows.ts`)
takes the same lead: a priced plan in REQUEST mode uses the 2-hour request lead.
`isBookableWindow` offers a window only when its `bookingStatus` is `available`;
a partly booked window is never offered to a buyer, because every writer refuses
a half-taken half-hour.

The consultant's allocate and availability grids stay desktop-only behind
`DesktopOnlyNotice`. On a phone the allocate page shows "Auto-schedule in my open
hours" under the notice (`components/scheduling/MobileAutoSchedule.tsx`): one
auto-mode allocation of a consultation or subscription, with `topUp` (and
`allowPartial`) for a plan that already holds confirmed sessions.

## Deprecated & Superseded Approaches

- **The locked palette with stripe angles.** An earlier grid told "outside
  period" and "past" apart only by a 45° versus 135° stripe and gave
  "rescheduling" the "partly booked" amber with a dashed border. The token table
  in §7 replaced it with a distinct cue per state.
- **Browser-local grid rows.** Cells were once built from the browser's local
  `Date`, which dropped or doubled an hour on DST days and could not draw
  :30/:45 offsets. Use `dayRows` and `cellInstant`.
- **The Sunday-week subscription cap.** The client counted subscription sessions
  per calendar week beside the rolling cycle, so the two caps disagreed at cycle
  edges. The fixed plan week is the only weekly counter.
- **The delivery-gated rolling cycle.** A subscription's next 7-day window once
  opened only after the previous batch was delivered, anchored on the last
  session's end. Plan weeks are now fixed from the plan start (§4).
- **`splitSlotsByDay`.** Blocks were cut at the viewer's midnight, which pushed
  :45-zone viewers off the half-hour lattice. Deleted; windows snap to the UTC
  lattice and are keyed by their own start's viewer day.
- **One 15-minute "Too soon" on every grid, and an inclusive `dayRangeBounds`
  end.** The grid now honours the caller's purpose (`leadMsFor`), and the range
  end is the next day's first instant.
- **Partly booked windows offered as "Request".** `isBookableWindow` now requires
  `available`.
- **`leadTimeFor`.** Replaced by `leadMsFor(purpose, { settled })`.
- **Dropping custom rows longer than 24 hours from the grid.** The grid route
  discarded them as unreasonable, so a coalesced multi-day row drew an empty
  grid while the allocator placed sessions in it. The range clip bounds the work.
- **Matching a custom row on its start day only.** The auto search used to offer
  a custom row on the UTC day its `startsAt` fell on (`matchCustomSlotToDay`) and
  walk at most 48 starts from there, so a multi-day row offered only its first
  24 hours and a row that began before the period offered nothing. Replaced by
  the per-day slices in §6.
- **A single-instant overlap probe.** The allocator once probed one span from
  the earliest to the latest pick, so a session between two picks read as taken.
