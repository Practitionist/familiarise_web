/**
 * Folds the week grid's dead hours into strips (#1703 F1).
 *
 * A consultant who publishes 09:00–19:00 was scrolling 28 rows of nothing to
 * reach the 20 that matter. Rows where no column in the visible week has
 * anything published, booked or belonging to this event fold into one strip
 * per contiguous band ("Unavailable · 00:00–09:00"); the strip expands on
 * click. The liveness vector comes from the FETCHED grid, never from the
 * profile, so a custom-availability week folds to its own shape.
 */

export type RowSegment =
  /** Rows `from` to `to` (exclusive) render as normal grid rows. */
  | { kind: "rows"; from: number; to: number }
  /** Rows `from` to `to` (exclusive) fold into one strip. */
  | { kind: "band"; from: number; to: number };

export interface FoldedRows {
  segments: RowSegment[];
  /** True when nothing in the week is live: the whole day shows, with a notice. */
  allDead: boolean;
}

/**
 * `live[i]` is true when row `i` has at least one live cell across the week.
 * A week with no live rows folds nothing — hiding every row would leave the
 * consultant a blank grid with no way to see where the day even is.
 */
export function foldDeadHourBands(live: readonly boolean[]): FoldedRows {
  if (!live.some(Boolean)) {
    return {
      segments: [{ kind: "rows", from: 0, to: live.length }],
      allDead: true,
    };
  }

  const segments: RowSegment[] = [];
  let index = 0;
  while (index < live.length) {
    const kind = live[index] ? "rows" : "band";
    const from = index;
    while (index < live.length && (live[index] ? "rows" : "band") === kind) {
      index += 1;
    }
    segments.push({ kind, from, to: index });
  }
  return { segments, allDead: false };
}

/** A stable identity for a band, so "expanded" survives a re-render and a session. */
export function bandKey(segment: RowSegment): string {
  return `${segment.from}-${segment.to}`;
}

/**
 * The row the focus effect should land on when its target sits inside a
 * folded band: the first visible row at or after it, else the last visible
 * row before it. `visibleRows` is ascending.
 */
export function nearestVisibleRow(
  target: number,
  visibleRows: readonly number[],
): number | null {
  if (visibleRows.length === 0) return null;
  const atOrAfter = visibleRows.find((row) => row >= target);
  return atOrAfter ?? visibleRows[visibleRows.length - 1];
}
