# DST & Timezone Posture (#872 stub — read before touching availability)

> Status: **IST-first launch today; the reader flip to per-date offsets is decided and lands in Wave 1** (D4). This page is
> the caveat sheet the audit asked for: what the stub does, what silently
> breaks, and the rules for any code that touches availability time math.

## What the launch model is

- `AvailabilityWindowWeekly` stores **minutes-since-midnight UTC**
  (`startTimeUtc`/`endTimeUtc`) plus a **frozen `utcOffsetMinutes`** captured
  at row creation. That frozen offset — NOT an IANA zone — is the live source
  of truth for projecting weekly rows onto concrete dates.
- The DST-correct representation (local wall-clock + IANA `timezone` +
  `localStartMinutes`/`localEndMinutes`/`localStartDay`/`localEndDay`) exists as
  nullable columns and is **dual-written from 2026-09-05 and read by nothing**.
  Every weekly write path fills the five columns from
  `weeklyRowLocalColumns` (`utils/schedule/weekly-projection.ts`), so the reader
  flip inherits correct values for every row written from that date onward
  without a backfill; going DST-aware still needs no migration, only the
  algorithm and UI work tracked in #872.
- Custom availability (`AvailabilityWindowCustom`) stores absolute UTC instants
  — unaffected by the stub.
- Event bucketing (`dayKey`/`weekKey`, ADR B9) uses each event's
  `schedulingTimezone` via date-fns-tz, which IS DST-correct for the zones it
  evaluates. The stub only affects **weekly availability projection**.

## The silent hazard

A consultant whose UTC offset changes after publishing availability (travels,
or their zone enters DST) gets future sessions materialized at the OLD offset:
a Mon 09:00 IST row becomes Mon 03:30 UTC forever, even after the consultant
is at UTC+1. Both parties then see consistent-but-wrong local labels, because
every surface renders in viewer-local time.

## Rules until #872 lands

1. Never READ the local\* columns from new code, and never write them by hand.
   They are dual-written for the #872 reader flip and nothing else consults
   them, so a reader added now would be a second source of truth against a
   frozen offset that is still the live one. Write them only by calling
   `weeklyRowLocalColumns`, and if you add a write path that creates or
   recreates weekly rows — `coalesceConsultantWeeklyRows` is the one that
   deletes and recreates — carry the five columns across, or the next coalesce
   silently unwrites them.
2. Any NEW consumer of weekly availability MUST go through the shared
   projection helpers — `utcStartDayIndex`, `weeklyRowDurationMinutes` and
   `weeklyRowOccurrencesInRange` in `utils/schedule/weekly-projection.ts`, or
   the `isMinuteWithinWeeklySlot` / `getNextOccurrenceWeekly` /
   `matchWeeklySlotToDay` wrappers that call them — so the frozen-offset
   semantics stay in one place. Deriving a weekday from the viewer's clock is
   the specific mistake this rule exists to stop (#1342).
3. Do not "fix" a +5:30 mismatch by editing offsets by hand — regenerate the
   consultant's availability rows instead. `utcOffsetMinutes` is never taken
   from a request body either: `resolveWeeklyUtcOffsetMinutes`
   (`lib/scheduling/weeklyUtcOffset.ts`) derives it from the consultant's
   `User.timezone`, falls back to 330 when the profile carries no usable zone,
   and answers a caller-supplied value that contradicts the profile with a 400
   carrying `code: "UTC_OFFSET_CONFLICT"` (#1326, #1348).
4. The drift warning asked for here now exists. Every weekly save whose
   consultant profile names a zone other than `Asia/Kolkata` reports one
   Sentry warning per write (never one per row), which is the signal that a
   consultant is publishing from outside the launch market and that the #872
   reader work has become due. `PIN_TO_LAUNCH_OFFSET` in the same module is the
   one-line switch that hard-pins every row to IST if that answer is ever
   preferred to the profile's own offset.

## Decision and plan (D4, landing in Wave 1)

The owner decided to flip the readers now rather than after launch. Wave 1 is code-only plus three small interface touches, and it needs no data migration because every weekly write path already fills the local columns.

- **Instant-based matcher.** `isMinuteWithinWeeklySlot(utcDay, utcMinutes, …, offset)` is replaced by a matcher that takes the row's IANA `timezone` and local minutes and converts them with `date-fns-tz` for each concrete date. A local time that does not exist on a spring-forward day is skipped, and a local time that occurs twice on a fall-back day takes its first occurrence.
- **Readers to flip.** `utils/schedule/weekly-projection.ts`, `utils/scheduling-engine/availabilityCoverage.ts`, `ScheduleValidationService.ts`, `app/api/scheduling/availability-with-allocation/[consultantId]/route.ts`, `uncovered-upcoming.ts`, `app/api/user/consultants/[id]/route.ts`, `utils/schedule/formatting.ts`, `mergeAdjacentWeeklyRows.ts`, and the client bundle `lib/scheduling/calendarUtils.ts` used by `UnifiedCalendar.tsx`, `RequestedSlotsDialog.tsx` and `useScheduling.ts`.
- **Also fixed in the same wave.** The last 23:30 atom of a window is no longer dropped, fetch bounds stop using the browser's local zone, the tail of an overnight row is no longer skipped, and the seed writes the local columns instead of nulls. A decision on zones with a +5:45 offset is stated in the pull request.
- **Interface.** The availability editor labels the zone "follows daylight saving", a one-time "convert weekly hours?" prompt appears when the profile zone changes (existing rows keep their own `timezone`), and a banner appears when the browser zone differs from the profile zone.
- **Proof.** Property tests cover New York, London and Sydney transitions, overnight rows, the last atom and a leap day.

Until the flip lands, the rules above still apply: the frozen offset is the live source of truth, and the local columns are written but never read. A worked example of the one-hour error a New York expert sees after 1 November is in [the machinery guide](../start-here/03-booking-and-money-machinery.md#example-9--daylight-saving-a-new-york-experts-monday-0900-wrong-by-one-hour-today-fixed-in-wave-1).

## Related

- Schema doc-comment block on `AvailabilityWindowWeekly` (prisma/schema.prisma)
- #1168 — draw the slot grid in `schedulingTimezone` (prerequisite for #872)
- #1200 — the travel-hazard operational caveat this page documents; folded into
  #872 as a single post-MVP DST issue (2026-09-02 decision, tracked under
  #1319)

## Deprecated & Superseded Approaches

1. **Deferring daylight saving to after launch.** The original posture accepted the frozen-offset hazard for an IST-only market. Decision D4 reverses it, and the rule "never read the local columns" ends when Wave 1 lands.
2. **A hand-edited `utcOffsetMinutes`.** The offset is derived from the profile zone and never taken from a request body; the instant-based matcher removes the need for it.
