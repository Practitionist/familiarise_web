/**
 * The dashboard heat map as data: one resolved cell per (row, day), built
 * once per data change so rendering is a lookup and every reader (paint,
 * open-hours window, legend, click guard, keyboard) agrees on what a cell is.
 */
import {
  resolveSlotStatusKey,
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";
import type { WeekRowModel } from "@/lib/time/grid-zone";

export interface OverlapDetail {
  id: string;
  type: string;
  title: string;
  with?: string;
}

/** A server cell, indexed by its start instant. */
export interface ServerCell {
  startMs: number;
  endMs: number;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  tooSoon: boolean;
  limitReached: boolean;
  overlappingAppointments: OverlapDetail[];
}

export interface AtomContext {
  serverCells: ReadonlyMap<number, ServerCell>;
  /** This booking's confirmed sessions (and a fresh request's own holds), by atom start. */
  eventStarts: ReadonlySet<number>;
  /** This booking's sessions released for a reschedule, by atom start. */
  tentativeStarts: ReadonlySet<number>;
  selectedStarts: ReadonlySet<number>;
  /** Selected atoms the latest poll says someone else now holds. */
  justTakenStarts: ReadonlySet<number>;
  /** The client's requested times (allocate grid), by atom start. */
  requestedStarts: ReadonlySet<number>;
  nowMs: number;
  allowedStartMs?: number;
  allowedEndMs?: number;
  /** The server's lead time for this grid's purpose, re-applied between polls. */
  leadMs?: number | null;
}

/** Too soon for this grid's writer: the server said so, or the clock has since moved. */
function isTooSoonAt(
  startMs: number,
  endMs: number,
  server: ServerCell | undefined,
  ctx: Pick<AtomContext, "nowMs" | "leadMs">,
): boolean {
  if (server?.tooSoon === true) return true;
  if (ctx.leadMs === undefined || ctx.leadMs === null) return false;
  return endMs > ctx.nowMs && startMs <= ctx.nowMs + ctx.leadMs;
}

/** What one 30-minute atom is, before any markup. */
export interface AtomState {
  startMs: number;
  endMs: number;
  statusKey: SlotStatusKey;
  /** Published (any status), this booking's, or booked: the row is not dead. */
  isLive: boolean;
  isAvailable: boolean;
  isBooked: boolean;
  isInPast: boolean;
  isTooSoon: boolean;
  isLimitReached: boolean;
  isOutsidePeriod: boolean;
  isThisEvent: boolean;
  isTentative: boolean;
  isRequested: boolean;
  overlapping: OverlapDetail[];
}

const NONE: OverlapDetail[] = [];

export function isOutsideAllowedRange(
  startMs: number,
  endMs: number,
  allowedStartMs?: number,
  allowedEndMs?: number,
): boolean {
  if (allowedStartMs !== undefined && startMs < allowedStartMs) return true;
  if (allowedEndMs !== undefined && endMs > allowedEndMs) return true;
  return false;
}

/** One resolver for an atom, shared by the cell matrix and the click guard. */
export function describeAtom(
  startMs: number,
  endMs: number,
  ctx: AtomContext,
): AtomState {
  const server = ctx.serverCells.get(startMs);
  const isAvailable = server?.bookingStatus === "available";
  const isFullyBooked = server?.bookingStatus === "fully-booked";
  const isPartiallyBooked = server?.bookingStatus === "partially-booked";
  const isThisEvent = ctx.eventStarts.has(startMs);
  const isTentative = ctx.tentativeStarts.has(startMs);
  const isInPast = endMs < ctx.nowMs;
  const isOutsidePeriod = isOutsideAllowedRange(
    startMs,
    endMs,
    ctx.allowedStartMs,
    ctx.allowedEndMs,
  );
  const isTooSoon = isTooSoonAt(startMs, endMs, server, ctx);
  const isLimitReached = server?.limitReached === true;
  const statusKey = resolveSlotStatusKey({
    isSelected: ctx.selectedStarts.has(startMs),
    isJustTaken: ctx.justTakenStarts.has(startMs),
    isThisEventSlot: isThisEvent,
    isRescheduling: isTentative,
    isBookedForDisplay: isFullyBooked,
    isPartiallyBooked,
    isAvailable,
    isOutsidePeriod,
    isTooSoon,
    isLimitReached,
    isInPast,
  });
  return {
    startMs,
    endMs,
    statusKey,
    isLive: Boolean(server) || isThisEvent || isTentative,
    isAvailable,
    isBooked: isFullyBooked || isPartiallyBooked,
    isInPast,
    isTooSoon,
    isLimitReached,
    isOutsidePeriod,
    isThisEvent,
    isTentative,
    isRequested: ctx.requestedStarts.has(startMs),
    overlapping: server?.overlappingAppointments ?? NONE,
  };
}

/** A cell ready to render: the atom plus its state's name. Busy runs are labelled by their block, not the cell. */
export interface CellView extends AtomState {
  /** The state's full name, for the accessible label, tooltip and block label. */
  stateLabel: string;
}

export interface WeekCells {
  /** `[axisIndex][dayIndex]`; null where a clock change skips that time. */
  matrix: (CellView | null)[][];
  /** Rows with an in-period live or requested cell; they bound the open-hours window. */
  live: boolean[];
  /** Rows with an outside-period cell, so an empty window can say why. */
  outsidePeriod: boolean[];
  paintedKeys: ReadonlySet<SlotStatusKey>;
  paintedCounts: ReadonlyMap<SlotStatusKey, number>;
  /** Atom start → cell, for the visible week. */
  byStart: ReadonlyMap<number, CellView>;
}

function stateLabelOf(atom: AtomState): string {
  if (atom.statusKey === "thisEvent" && atom.isInPast) return "Past session";
  return SLOT_STATUS_TOKENS[atom.statusKey].label;
}

/** One pass over the week: cells, the fold vectors and the legend's painted set. */
export function buildWeekCells(
  rows: WeekRowModel,
  ctx: AtomContext,
): WeekCells {
  const painted = new Set<SlotStatusKey>();
  const counts = new Map<SlotStatusKey, number>();
  const byStart = new Map<number, CellView>();
  const live: boolean[] = [];
  const outsidePeriod: boolean[] = [];

  const matrix = rows.axis.map((axisRow) => {
    let rowLive = false;
    let rowOutside = false;
    const line = rows.cells.map((dayCells) => {
      const row = dayCells.get(axisRow.key);
      if (!row) return null;
      const atom = describeAtom(row.start.getTime(), row.end.getTime(), ctx);
      const cell: CellView = { ...atom, stateLabel: stateLabelOf(atom) };
      painted.add(cell.statusKey);
      counts.set(cell.statusKey, (counts.get(cell.statusKey) ?? 0) + 1);
      if (cell.statusKey === "outsidePeriod") rowOutside = true;
      else if (cell.isLive || cell.isRequested) rowLive = true;
      byStart.set(cell.startMs, cell);
      return cell;
    });
    live.push(rowLive);
    outsidePeriod.push(rowOutside);
    return line;
  });

  return {
    matrix,
    live,
    outsidePeriod,
    paintedKeys: painted,
    paintedCounts: counts,
    byStart,
  };
}

/** Rows of padding the open-hours window keeps above and below the live rows: one hour. */
export const OPEN_HOURS_PAD_ROWS = 2;

/** A contiguous run of axis rows, `from` inclusive to `to` exclusive. */
export interface RowWindow {
  from: number;
  to: number;
}

/**
 * The "Open hours" view: the earliest to the latest live row of the week,
 * padded by an hour each side and clamped to the day. Closed rows inside it
 * stay visible. Null when nothing in the week is live.
 */
export function openHoursWindow(
  live: readonly boolean[],
  padRows: number = OPEN_HOURS_PAD_ROWS,
): RowWindow | null {
  const first = live.indexOf(true);
  if (first === -1) return null;
  const last = live.lastIndexOf(true);
  return {
    from: Math.max(0, first - padRows),
    to: Math.min(live.length, last + 1 + padRows),
  };
}

export type JustTakenReason = "taken" | "expired";

/**
 * Selected atoms the latest data no longer allows, inside the window the data
 * covers. "taken" when someone else now holds it or it is no longer
 * published; "expired" when it slid into the past, the notice period or a
 * used-up limit. This booking's own sessions are never conflicts.
 */
export function selectionConflicts(
  selectedStarts: Iterable<number>,
  ctx: AtomContext,
  window: { startMs: number; endMs: number } | null,
): Map<number, JustTakenReason> {
  const conflicts = new Map<number, JustTakenReason>();
  if (!window) return conflicts;
  for (const startMs of selectedStarts) {
    if (startMs < window.startMs || startMs >= window.endMs) continue;
    if (ctx.eventStarts.has(startMs)) continue;
    const server = ctx.serverCells.get(startMs);
    if (server?.bookingStatus !== "available") {
      conflicts.set(startMs, "taken");
    } else if (
      server.endMs < ctx.nowMs ||
      isTooSoonAt(server.startMs, server.endMs, server, ctx) ||
      server.limitReached
    ) {
      conflicts.set(startMs, "expired");
    }
  }
  return conflicts;
}
