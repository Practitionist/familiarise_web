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

| Declaration                                                                            | File                                                                                                                                                                                                    | Behaviour                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLOT_GRID_MS`                                                                         | `lib/payments/utils/slot-validation.ts`                                                                                                                                                                 | **Rejects off-grid.** `slotStartRefusal` refuses a client-picked start with `SLOT_NOT_ON_GRID` when `start % 30min !== 0`. The only place 30 minutes is a constraint _on a timestamp_.                                                         |
| `SLOT_ATOM_MS`                                                                         | `utils/appointmentlock.ts`                                                                                                                                                                              | **Floors to the grid.** `Math.floor(startsAt / SLOT_ATOM_MS) * SLOT_ATOM_MS`, then steps. Deliberately a superset: a `:15` start takes both the `:00` and `:30` atoms, so two writers can never hold disjoint keys for the same booked minute. |
| `ATOM_MS`, `slidingIntervalMillis`, `SCHEDULING_INTERVAL_MS`, `SLOT_MS`, `thirtyMinMs` | `utils/scheduling-engine/availabilityCoverage.ts`, `utils/scheduling-engine/intervals.ts`, `lib/appointments/occurrences.ts`, `schemas/appointments.ts`, `utils/scheduling-engine/SchedulingService.ts` | **Steps from an arbitrary anchor.** Never consults the epoch — it steps from whatever start it is handed, so a window opening at `:15` yields `:15`/`:45` atoms.                                                                               |
| `THIRTY_MIN_MS`                                                                        | `utils/scheduling-engine/intervals.ts`                                                                                                                                                                  | **Not an atom.** Used only as a `Math.floor(ms / X)` _bucket divisor_ for index keys in `buildAppointmentIndex` and in `lib/booking/overlap-meta.ts`. It has no window semantics, so "the atom" is the wrong name for it.                      |
| `intervalDurationMs`                                                                   | `utils/scheduling-engine/interval-meta.ts`                                                                                                                                                              | **A duration, not a grid.** The "is this 30-minute interval already full?" threshold.                                                                                                                                                          |

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
(`lib/payments/operations/checkout.ts`), and the trial route
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
private `SchedulingService.findAvailableSlots` for the allocator.

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

Segmentation and merging carry two more boundary rules. `splitSlotsByDay` cuts a
window at the next local day's midnight rather than at 23:59:59.999, because a
23:30–23:59:59.999 remainder is not a thirty-minute atom and a block published
up to local midnight otherwise lost its last slot (#1415). Both merge functions
— `mergeConsecutiveSlots` for booking and `mergeConsecutiveSlotsForDisplay`
(`app/explore/experts/[consultantId]/utils/mergeSlots.ts`) for the expert page —
require exact adjacency, and differ only in which atoms are eligible; a
tolerance on either side advertises a seam no row publishes (#1416).

The grid is `GET /api/scheduling/availability-with-allocation/[consultantId]` with
`startDateInUtc`, `endDateInUtc` and `timezone`, public in `middleware.ts`. The
expert page asks for `zonedWeekWindow` bounds — viewer-zone local midnight to the
local midnight seven days later, end exclusive — so the week's last 23:30 atom is
inside the window.
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

`utils/scheduling-engine/SchedulingService.ts` is about 6,000 lines and owns all
three modes, so find a path by function name (`allocate`, `autoAllocate`,
`manualAllocate`, `useRequestedSlots`) rather than by scrolling. A pure-move split
of the file is planned **(after Wave 2)**.

Allocation goes through **one handler route** as of #1702:
`lib/scheduling/allocate-route.ts` carries the whole auth → limiter → Zod →
`SchedulingService` → typed-error contract, and each of the four `PATCH …/allocate`
routes is a thin delegator that only resolves its own typed segment param. There
is no per-event-type copy of the allocate logic to drift out of sync.

A conflict on allocation answers one of a typed family, not a bare 409: `AllocationErrorCode`
carries `LOCK_CONTENTION` (Redis lock busy or a replay in flight), `ALREADY_ALLOCATED`
(confirmed slots already exist), `RESCHEDULE_STATE_CHANGED` (the stale-tab case —
the tentative-slot count moved since the client loaded the page), and `SLOT_TAKEN`
(a chosen time went to someone else mid-allocation). A client must branch on
`errorCode`, never on the message wording: the message is free to change for
readability, and only `ALREADY_ALLOCATED` is the one code that should close the
dialog and drop the row — every other code should keep the dialog open and
refetch the grid, because the underlying request is still live and retriable.

Also as of wave 5 (#1329), the co-host guard runs in **every** allocation mode:
`SchedulingService.assertCollaboratorsFree` calls
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

## Grid states, and how they are painted (#1703 D6)

`lib/scheduling/interval-status-tokens.ts` is the single colour vocabulary the
grid, the legend and the time picker all read from, so a swatch can never
document a state the cells do not actually paint. Two states are hatched
rather than given a new hue, because the palette itself is locked: `outsidePeriod`
(inside the consultant's published hours but outside this booking's own
scheduling period) uses a 45° stripe, and `past` (already gone, shown only so
the day reads whole) uses a 135° stripe, so the two "not really available"
states cannot be mistaken for each other at a glance. `rescheduling` (a slot a
reschedule released, awaiting a new time) keeps the same amber fill as
`partiallyBooked` but adds a dashed border, because two solid-amber states next
to each other read as one state. `unavailable` (outside the consultant's
published hours at all) is flat — no fill, no border — because the dead-hour
folding on the allocate grid already names those hours in a collapsed strip,
so the cells inside it can go quiet rather than repeat the same grey the whole
row already announced.
