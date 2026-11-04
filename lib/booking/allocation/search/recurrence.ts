// Projects weekly and custom availability rows onto the days the search walks.

import { weeklyRowIntervalsInRange } from "@/utils/schedule/weekly-projection";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { dayRangeBounds } from "@/lib/time/grid-zone";
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import {
  type ProjectableWeeklyRow,
  type RowSpan,
  DAY_MS,
} from "@/lib/booking/allocation/search/constants";

/** Weekly rows ordered by their next occurrence after `now`; rows with none sort last. */
export function sortWeeklyByNextOccurrence(
  rows: ProjectableWeeklyRow[],
  now: Date,
): ProjectableWeeklyRow[] {
  const horizon = new Date(now.getTime() + 15 * DAY_MS);
  const nextStart = (row: ProjectableWeeklyRow) =>
    weeklyRowIntervalsInRange(row, now, horizon)
      .find((occurrence) => occurrence.start > now)
      ?.start.getTime() ?? Number.POSITIVE_INFINITY;
  return rows
    .map((row) => ({ row, next: nextStart(row) }))
    .sort((a, b) => a.next - b.next)
    .map(({ row }) => row);
}

const onLattice = (ms: number) =>
  Math.ceil(ms / SCHEDULING_INTERVAL_MS) * SCHEDULING_INTERVAL_MS;

/**
 * One custom row cut at the scheduling zone's midnights: a slice per covered
 * calendar day, each clipped to the row's own absolute start and end, in order.
 * Cuts sit on the UTC half-hour lattice, so an atom belongs to the day its start
 * falls on and a :45 zone's straddling atom is not lost between two slices.
 */
export function customRowDaySlices(
  row: { startsAt: Date; endsAt: Date },
  timeZone: string = ScheduleCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
): RowSpan[] {
  const startMs = new Date(row.startsAt).getTime();
  const endMs = new Date(row.endsAt).getTime();
  const slices: RowSpan[] = [];
  const first = ScheduleCalculationService.wallClock(
    new Date(startMs),
    timeZone,
  );
  for (let offset = 0; ; offset++) {
    // A local-noon date names the calendar day; `dayRangeBounds` reads only its fields.
    const day = new Date(first.year, first.month - 1, first.day + offset, 12);
    const { start, end } = dayRangeBounds(day, day, timeZone);
    const dayStartMs = onLattice(start.getTime());
    if (!(dayStartMs < endMs)) break;
    const sliceStart = Math.max(startMs, dayStartMs);
    const sliceEnd = Math.min(endMs, onLattice(end.getTime()));
    if (sliceEnd > sliceStart) {
      slices.push({ start: new Date(sliceStart), endMs: sliceEnd });
    }
  }
  return slices;
}

/**
 * Every custom row's scheduling-zone day slices, ordered by start, so a long
 * row's later days interleave with the rows that start inside it.
 */
export function customSpansInStartOrder(
  rows: readonly { startsAt: Date; endsAt: Date }[],
  timeZone?: string,
): RowSpan[] {
  return rows
    .flatMap((row) => customRowDaySlices(row, timeZone))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}
