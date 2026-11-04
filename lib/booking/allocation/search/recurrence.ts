// Projects weekly and custom availability rows onto the days the search walks.

import { weeklyRowIntervalsInRange } from "@/utils/schedule/weekly-projection";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import { dayStartInstant } from "@/lib/time/grid-zone";
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
  // An invalid Date reads NaN; it is refused here explicitly.
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return [];
  }
  const firstDay = ScheduleCalculationService.dayKey(
    new Date(startMs),
    timeZone,
  );
  // A row inside one zone day is its own slice; the cut search is skipped.
  if (
    firstDay ===
    ScheduleCalculationService.dayKey(new Date(endMs - 1), timeZone)
  ) {
    return [{ start: new Date(startMs), endMs }];
  }
  const [year, month, day] = firstDay.split("-").map(Number);
  // A local-noon date names the calendar day; `dayStartInstant` reads only its
  // fields. Each day's exclusive end is the next day's start, carried forward.
  const dayStartMs = (offset: number) =>
    onLattice(
      dayStartInstant(
        new Date(year, month - 1, day + offset, 12),
        timeZone,
      ).getTime(),
    );
  const slices: RowSpan[] = [];
  let cutMs = dayStartMs(0);
  let offset = 1;
  while (cutMs < endMs) {
    const nextCutMs = dayStartMs(offset++);
    if (!Number.isFinite(nextCutMs) || nextCutMs <= cutMs) break;
    const sliceStart = Math.max(startMs, cutMs);
    const sliceEnd = Math.min(endMs, nextCutMs);
    if (sliceEnd > sliceStart) {
      slices.push({ start: new Date(sliceStart), endMs: sliceEnd });
    }
    cutMs = nextCutMs;
  }
  return slices;
}

/**
 * The day slices of every custom row that overlaps `[window.startMs,
 * window.endMs)`, each row clipped to the window first, in start order so a
 * long row's later days interleave with the rows that start inside it. A
 * generator, so a consumer that stops early (the single-session walk's first
 * fit) never slices the rows past where it stopped.
 */
export function* customSpansInStartOrder(
  rows: readonly { startsAt: Date; endsAt: Date }[],
  timeZone: string | undefined,
  window: { startMs: number; endMs: number },
): Generator<RowSpan> {
  const clipped = rows
    .map((row) => ({
      startMs: Math.max(new Date(row.startsAt).getTime(), window.startMs),
      endMs: Math.min(new Date(row.endsAt).getTime(), window.endMs),
    }))
    .filter((row) => row.endMs > row.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  // Slices already cut but not yet walked, in start order.
  let pending: RowSpan[] = [];
  for (const row of clipped) {
    for (
      let head = pending.at(0);
      head && head.start.getTime() <= row.startMs;
      head = pending.at(0)
    ) {
      pending = pending.slice(1);
      yield head;
    }
    pending = [
      ...pending,
      ...customRowDaySlices(
        { startsAt: new Date(row.startMs), endsAt: new Date(row.endMs) },
        timeZone,
      ),
    ].sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  yield* pending;
}
