/**
 * The week grid's session blocks: contiguous same-day runs of a busy or
 * picked state, drawn as one labelled overlay ("Booked · 10:00–11:30")
 * instead of a pill per half-hour. Pure, so the overlay, its tests and any
 * reader agree on where a run starts and ends.
 */
import type { SlotStatusKey } from "@/lib/scheduling/interval-status-tokens";
import type { CellView } from "@/lib/scheduling/week-grid-model";
import { formatClockTime } from "@/lib/time/display";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";

/** The states drawn as blocks; every other state stays a per-cell fill. */
export const BLOCK_STATES: ReadonlySet<SlotStatusKey> = new Set<SlotStatusKey>([
  "fullyBooked",
  "partiallyBooked",
  "thisEvent",
  "selected",
  "rescheduling",
  "justTaken",
]);

/** The cell fields a block reads. */
export type BlockCell = Pick<
  CellView,
  | "startMs"
  | "endMs"
  | "statusKey"
  | "stateLabel"
  | "isRequested"
  | "overlapping"
>;

export interface GridBlock {
  /** Stable across renders: the day column and the run's first instant. */
  key: string;
  dayIndex: number;
  /** Axis index of the first row the block covers. */
  fromRow: number;
  /** Axis index one past the last row it covers (skipped rows inside count). */
  toRow: number;
  startMs: number;
  endMs: number;
  statusKey: SlotStatusKey;
  /** Every atom of the run is one the client asked for. */
  isRequested: boolean;
  /** The overlapping booking's title when the route sent one, else the state's label. */
  label: string;
  /** "10:00 am–11:30 am" in the grid's zone. */
  timeLabel: string;
}

/** The booking an atom belongs to, so back-to-back bookings stay two blocks. */
function ownerOf(cell: BlockCell): string {
  return cell.overlapping[0]?.id ?? "";
}

function blockLabel(cell: BlockCell): string {
  const title =
    cell.statusKey === "fullyBooked" || cell.statusKey === "partiallyBooked"
      ? cell.overlapping[0]?.title
      : undefined;
  return title || cell.stateLabel;
}

/**
 * Merges `matrix[axisIndex][dayIndex]` into blocks. An atom joins the open
 * run only when it paints the same block state, has the same requested flag
 * and booking, starts exactly when the run ends, and falls on the same
 * calendar day in `zone` (the `dayKey` rule `groupSelectedIntoSessions`
 * uses), so a run never crosses local midnight. A null cell (a time the
 * clocks skip that day) neither breaks nor extends a run.
 */
export function buildGridBlocks(
  matrix: readonly (readonly (BlockCell | null)[])[],
  zone: string,
): GridBlock[] {
  const blocks: GridBlock[] = [];
  const days = matrix.reduce((most, line) => Math.max(most, line.length), 0);
  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    let open: {
      first: BlockCell;
      last: BlockCell;
      fromRow: number;
      toRow: number;
      dayKey: string;
    } | null = null;
    const close = () => {
      if (!open) return;
      blocks.push({
        key: `${dayIndex}:${open.first.startMs}`,
        dayIndex,
        fromRow: open.fromRow,
        toRow: open.toRow,
        startMs: open.first.startMs,
        endMs: open.last.endMs,
        statusKey: open.first.statusKey,
        isRequested: open.first.isRequested,
        label: blockLabel(open.first),
        timeLabel: `${formatClockTime(new Date(open.first.startMs), { zone })}–${formatClockTime(new Date(open.last.endMs), { zone })}`,
      });
      open = null;
    };
    matrix.forEach((line, row) => {
      const cell = line[dayIndex];
      if (!cell) return;
      if (!BLOCK_STATES.has(cell.statusKey)) {
        close();
        return;
      }
      const dayKey = ScheduleCalculationService.dayKey(
        new Date(cell.startMs),
        zone,
      );
      if (
        open &&
        open.last.statusKey === cell.statusKey &&
        open.last.isRequested === cell.isRequested &&
        ownerOf(open.last) === ownerOf(cell) &&
        open.last.endMs === cell.startMs &&
        open.dayKey === dayKey
      ) {
        open.last = cell;
        open.toRow = row + 1;
        return;
      }
      close();
      open = { first: cell, last: cell, fromRow: row, toRow: row + 1, dayKey };
    });
    close();
  }
  return blocks;
}
