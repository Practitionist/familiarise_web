# DST & Timezone Posture (read before touching availability)

> Status: **weekly availability follows the expert's local clock** (#872). This
> page states how a weekly row becomes real instants, what the save path must
> write, and the rules for any code that touches availability time math.

## What a weekly row means

An `AvailabilityWindowWeekly` row means "this local wall-clock window, every
week, in this IANA zone". Five columns carry that meaning and every reader
projects from them alone:

| Column                                  | Meaning                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `timezone`                              | The IANA zone the hours are kept in, for example `America/New_York`.                   |
| `localStartDay`                         | The consultant's local weekday the window starts on.                                   |
| `localStartMinutes` / `localEndMinutes` | Minutes after local midnight (0–1439).                                                 |
| `localEndDay`                           | The local weekday the window ends on; differs from the start day for an overnight row. |

`weeklyRowIntervalsInRange` (`utils/schedule/weekly-projection.ts`) turns a row
into half-open UTC intervals. For every local date in the range whose weekday is
`localStartDay`, it builds the local start and end wall clocks and resolves them
through the zone's own rules, so a New York Monday 09:00–12:00 row is
13:00Z–16:00Z in summer and 14:00Z–17:00Z in winter. Two transition nights need a
rule, and the generator applies it in one place:

- **Spring forward.** A local time that does not exist (New York 02:30 on
  2026-03-08) is skipped for that date. It is never shifted to 03:30.
- **Fall back.** A local time that occurs twice (New York 01:30 on 2026-11-01)
  resolves to its first occurrence, 05:30Z.

India has no DST, so an `Asia/Kolkata` row projects to the same instants it
always did.

## Who reads it

The grid (`processWeeklySlots`), checkout and trial coverage
(`findUncoveredAtom` over `loadPublishedCoverage`), the shrink notice
(`findUncoveredUpcoming`), the allocator (`SchedulingService` through
`createWeeklyCoverage` and `weeklyRowIntervalsInRange`), the validator
(`validateMatchesSchedule`) and the co-host filter on the grid route all share
this one generator. The client never projects weekly rows itself: the expert page
and the allocation calendars draw what the grid endpoint returns, and the
settings editor reads the local columns straight into its form.

A row whose local columns are NULL or invalid is a data error. Every reader
refuses it through `partitionWeeklyRows` and reports once per call through
`reportIncompleteWeeklyRows`, throttled to one Sentry event per hour per
instance. There is no fallback read of the UTC columns.

## What the save path writes

The editor converts each typed slot on the probe date `WEEKLY_SAVE_PROBE_DATE`
(1970-01-01), so the stored `startTimeUtc`/`endTimeUtc` are the typed wall clock
minus the zone's offset on that date. `weeklyLocalColumnsForSave`
(`lib/scheduling/weeklyUtcOffset.ts`) adds the same offset back, which recovers
exactly what the consultant typed in every zone, including zones whose offset has
changed since 1970. Every writer derives the five columns this way before it
validates, merges and stores the row: the settings PUT, onboarding, the two
per-row routes, the zone conversion route and the seed.

Coalescing (`mergeAdjacentWeeklyRows`) compares the local columns: two rows fold
only when they share a zone and a local day, neither crosses local midnight, and
one ends exactly where the next begins. The pairwise overlap check
(`slotsOverlap`) also compares the local week.

`startTimeUtc`, `endTimeUtc`, `endDay` and `utcOffsetMinutes` are still written
for the overlap SQL and the reset batch, but no reader projects through them. A
guard test (`__tests__/scheduling/weekly-dst-projection.test.ts`) fails if any
file other than the writers mentions `utcOffsetMinutes`.

## Zones and the consultant's choices

- The settings editor edits weekly hours in the zone the rows carry, falling back
  to the profile zone. It labels the zone ("Times are in America/New_York and
  follow daylight saving automatically") and shows a banner when the browser's
  zone differs from it.
- When a consultant changes their profile timezone, the account page asks once:
  "Convert my weekly hours to <new zone>?". Converting calls
  `POST /api/scheduling/availability/weekly/zone`, which rewrites each row's
  `timezone` and keeps its local clock times. Keeping them leaves the rows in their
  own zone, and the availability page shows a persistent note saying so.
- **UTC+05:45 and other off-grid zones are refused for weekly hours.** The booking
  grid is 30 minutes in UTC, so a zone whose offset is not a whole number of
  30-minute atoms (Asia/Kathmandu, Australia/Eucla, Pacific/Chatham) puts every
  local :00/:30 start off the grid checkout enforces. `weeklyZoneRefusal`
  answers every weekly write with the `ZONE` refusal and points the consultant at
  date-specific availability, which snaps to the grid.

## Rules for new code

1. Project a weekly row only through `weeklyRowIntervalsInRange`,
   `isInstantWithinWeeklyRow` or `createWeeklyCoverage`. Never derive a weekday or
   an instant from the UTC columns or the viewer's clock.
2. Write the local columns only through `weeklyLocalColumnsForSave` (or
   `weeklyRowLocalColumns` with the offset the UTC minutes were derived with), and
   carry all five through any path that recreates rows.
3. Refuse a row without local columns and report it once per call; never per row.

## Deprecated & Superseded Approaches

- **Frozen-offset projection.** Until #872 each row was projected with the
  `utcOffsetMinutes` captured at save time (`utcStartDayIndex`,
  `weeklyRowOccurrencesInRange`, `isMinuteWithinWeeklySlot`), so an expert in a
  DST zone was bookable an hour off after every transition. Those helpers are
  deleted; remove any copy that resurfaces.
- **The non-IST drift warning.** Weekly saves outside Asia/Kolkata used to report
  a Sentry warning as the signal that this work was due. It was removed with the
  flip.
- **Today's offset for the local columns.** The dual-write derived the local
  columns from the save-time offset, while the editor converted on 1970-01-01,
  which stored the wrong local hour for DST zones saved in summer.
