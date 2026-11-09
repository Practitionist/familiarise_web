"use client";

import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";

import { SlotStatusIcon } from "@/components/scheduling/SlotStatusIcon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  REQUESTED_OUTLINE,
  SLOT_STATUS_TOKENS,
  slotCellClassName,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";
import type { GridBlock } from "@/lib/scheduling/grid-blocks";
import { GRID_COLS } from "@/lib/scheduling/week-grid-geometry";
import {
  fitLabel,
  type CellView,
  type OverlapDetail,
  type RowWindow,
} from "@/lib/scheduling/week-grid-model";
import {
  formatDateTimeLabel,
  formatDayOfMonth,
  formatWeekdayShort,
} from "@/lib/time/display";
import type { AxisRow } from "@/lib/time/grid-zone";
import { cn } from "@/utils/tailwind";

/**
 * The week heat map's markup: a valid ARIA grid (header row of column
 * headers, one row per time with a row header, one gridcell per day) with a
 * single roving tab stop. Cells are memoised and receive only primitives
 * plus objects that change with the data, so a focus move or a clock tick
 * re-renders a handful of cells rather than all of them.
 */

/** One half-hour row: 24px, so an hour is 48px. Blocks are placed on this pitch. */
export const GRID_ROW_PX = 24;

/** The sticky header's height, and the matching offset that puts the block layer under it. */
const HEADER_HEIGHT = "h-16";
const HEADER_OFFSET = "top-16";

/** A cell fills its slot on the ruled canvas: no radius, no gap, 11px text. */
const CELL_GEOMETRY = "h-6 rounded-none text-[11px]";

/** The rule under a row: solid where the next hour starts, dashed at the half-hour. */
const HOUR_RULE =
  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-slate-300";
const HALF_HOUR_RULE =
  "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:border-b after:border-dashed after:border-slate-200";

/** Closed time (nothing published) is a light hatch on the canvas, unlike past's fade or outside-period's stripe. */
const CLOSED_CANVAS =
  "bg-[repeating-linear-gradient(135deg,theme(colors.slate.100)_0_6px,theme(colors.slate.50)_6px_12px)]";

/** The canvas classes of one gridcell: the day-column line, the row rule and, when closed, the hatch. */
function canvasCellClass(endsHour: boolean, closed: boolean): string {
  return cn(
    "relative h-6 min-w-0 border-l border-slate-200",
    endsHour ? HOUR_RULE : HALF_HOUR_RULE,
    closed && CLOSED_CANVAS,
  );
}

/** The roving-focus key of an axis row. */
export function rowKeyOf(axisRow: AxisRow): string {
  return `row:${axisRow.key}`;
}

export interface GridFocus {
  rowKey: string;
  dayIndex: number;
}

/** One day column's share of the hover preview: the atoms a click would place. */
export interface GhostPiece {
  key: string;
  dayIndex: number;
  fromRow: number;
  toRow: number;
  /** False when no whole session fits at the hovered time. */
  fits: boolean;
  startMs: number;
  endMs: number;
  label: string;
}

export interface CellTooltip {
  title: string;
  lines: string[];
}

interface SlotCellProps {
  cell: CellView;
  dayIndex: number;
  rowKey: string;
  zone: string;
  /** The row ends on the hour, so its rule is solid. */
  endsHour: boolean;
  /** The cell above / below paints the same state: drop the shared border so the run reads as one. */
  joinTop: boolean;
  joinBottom: boolean;
  isFocusTarget: boolean;
  /** Fraction down the cell where the now-line sits, or null. */
  nowFraction: number | null;
  readOnly: boolean;
  tooltip: CellTooltip | null;
  /** Called with the atom start; the host resolves its live cell. */
  onActivate: (startMs: number) => void;
  onKeyDown: (
    event: React.KeyboardEvent<HTMLElement>,
    rowKey: string,
    dayIndex: number,
  ) => void;
  onFocusCell: (rowKey: string, dayIndex: number) => void;
  /** The pointer or focus is on this atom: preview what a click would place. */
  onPreview: (startMs: number) => void;
}

function NowLine({ fraction }: Readonly<{ fraction: number }>) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-primary"
      style={{ top: `${fraction * 100}%` }}
    >
      <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-primary" />
    </div>
  );
}

function sameTooltip(a: CellTooltip | null, b: CellTooltip | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.title === b.title && a.lines.join("\n") === b.lines.join("\n");
}

/** Cells are rebuilt on every data or selection change; compare what they paint. */
function sameCellProps(
  a: Readonly<SlotCellProps>,
  b: Readonly<SlotCellProps>,
): boolean {
  return (
    a.cell.startMs === b.cell.startMs &&
    a.cell.statusKey === b.cell.statusKey &&
    a.cell.stateLabel === b.cell.stateLabel &&
    a.cell.isRequested === b.cell.isRequested &&
    a.dayIndex === b.dayIndex &&
    a.rowKey === b.rowKey &&
    a.zone === b.zone &&
    a.endsHour === b.endsHour &&
    a.joinTop === b.joinTop &&
    a.joinBottom === b.joinBottom &&
    a.isFocusTarget === b.isFocusTarget &&
    a.nowFraction === b.nowFraction &&
    a.readOnly === b.readOnly &&
    sameTooltip(a.tooltip, b.tooltip) &&
    a.onActivate === b.onActivate &&
    a.onKeyDown === b.onKeyDown &&
    a.onFocusCell === b.onFocusCell &&
    a.onPreview === b.onPreview
  );
}

const SlotCell = memo(function SlotCell({
  cell,
  dayIndex,
  rowKey,
  zone,
  endsHour,
  joinTop,
  joinBottom,
  isFocusTarget,
  nowFraction,
  readOnly,
  tooltip,
  onActivate,
  onKeyDown,
  onFocusCell,
  onPreview,
}: Readonly<SlotCellProps>) {
  const token = SLOT_STATUS_TOKENS[cell.statusKey];
  const interactive = !readOnly && token.interactive;
  const label = [
    cell.stateLabel,
    cell.isRequested ? REQUESTED_OUTLINE.label : null,
    formatDateTimeLabel(new Date(cell.startMs), { zone }),
  ]
    .filter(Boolean)
    .join(" · ");
  const button = (
    <button
      type="button"
      tabIndex={isFocusTarget ? 0 : -1}
      aria-label={label}
      aria-disabled={interactive ? undefined : true}
      title={tooltip ? undefined : `${label}. ${token.hint}`}
      data-day-index={dayIndex}
      data-row-key={rowKey}
      data-slot-start={new Date(cell.startMs).toISOString()}
      data-slot-state={cell.statusKey}
      className={slotCellClassName(cell.statusKey, {
        className: cn(
          "flex items-center gap-0.5 overflow-hidden",
          CELL_GEOMETRY,
          joinTop && "border-t-0",
          joinBottom && "border-b-0",
          readOnly && "cursor-default",
          cell.isRequested && REQUESTED_OUTLINE.className,
        ),
      })}
      onClick={() => onActivate(cell.startMs)}
      onKeyDown={(event) => onKeyDown(event, rowKey, dayIndex)}
      onFocus={() => {
        onFocusCell(rowKey, dayIndex);
        onPreview(cell.startMs);
      }}
      onMouseEnter={() => onPreview(cell.startMs)}
    >
      <SlotStatusIcon name={token.icon} />
    </button>
  );
  return (
    <div
      role="gridcell"
      aria-selected={interactive ? cell.statusKey === "selected" : undefined}
      className={canvasCellClass(endsHour, cell.statusKey === "unavailable")}
    >
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent
            className="max-w-xs text-xs"
            side="top"
            align="center"
          >
            <p className="font-semibold">{tooltip.title}</p>
            {tooltip.lines.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {nowFraction !== null && <NowLine fraction={nowFraction} />}
    </div>
  );
}, sameCellProps);

const SkippedCell = memo(function SkippedCell({
  dayIndex,
  rowKey,
  endsHour,
  isRepeat,
  isFocusTarget,
  onKeyDown,
  onFocusCell,
}: Readonly<{
  dayIndex: number;
  rowKey: string;
  endsHour: boolean;
  /** The row is another day's repeated fall-back hour, not a time this day skips. */
  isRepeat: boolean;
  isFocusTarget: boolean;
  onKeyDown: SlotCellProps["onKeyDown"];
  onFocusCell: SlotCellProps["onFocusCell"];
}>) {
  return (
    <div role="gridcell" className={canvasCellClass(endsHour, true)}>
      <button
        type="button"
        tabIndex={isFocusTarget ? 0 : -1}
        aria-disabled
        aria-label={
          isRepeat
            ? "This time happens only once on this day"
            : "This time is skipped on this day because the clocks change"
        }
        data-day-index={dayIndex}
        data-row-key={rowKey}
        className="h-6 w-full cursor-not-allowed"
        onKeyDown={(event) => onKeyDown(event, rowKey, dayIndex)}
        onFocus={() => onFocusCell(rowKey, dayIndex)}
      />
    </div>
  );
});

/**
 * The overlay of session blocks, laid on the same columns and 24px row pitch
 * as the cells beneath. Decorative: the cells keep focus, clicks and names.
 */
function BlockLayer({
  blocks,
  ghost,
  rows,
}: Readonly<{
  blocks: readonly GridBlock[];
  ghost: readonly GhostPiece[];
  rows: RowWindow;
}>) {
  const count = rows.to - rows.from;
  const place = (dayIndex: number, fromRow: number, toRow: number) => {
    const from = Math.max(fromRow, rows.from);
    const to = Math.min(toRow, rows.to);
    return to <= from
      ? null
      : {
          gridColumn: dayIndex + 2,
          gridRow: `${from - rows.from + 1} / span ${to - from}`,
        };
  };
  return (
    <div
      aria-hidden
      data-testid="grid-blocks"
      className={cn(
        GRID_COLS,
        "pointer-events-none absolute inset-x-0 z-10",
        HEADER_OFFSET,
      )}
      style={{ gridTemplateRows: `repeat(${count}, ${GRID_ROW_PX}px)` }}
    >
      {blocks.map((block) => {
        const style = place(block.dayIndex, block.fromRow, block.toRow);
        if (!style) return null;
        const token = SLOT_STATUS_TOKENS[block.statusKey];
        return (
          <div
            key={block.key}
            data-block-state={block.statusKey}
            style={style}
            className={cn(
              "m-px flex min-w-0 items-start gap-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-xs leading-tight shadow-sm",
              token.fill,
              token.border,
              token.text,
              token.pattern,
              block.isRequested && REQUESTED_OUTLINE.className,
            )}
          >
            <SlotStatusIcon name={token.icon} className="mt-0.5" />
            <span className="min-w-0 break-words">
              <span className="font-medium">{block.label}</span>
              {` · ${block.timeLabel}`}
            </span>
          </div>
        );
      })}
      {ghost.map((piece) => {
        const style = place(piece.dayIndex, piece.fromRow, piece.toRow);
        if (!style) return null;
        return (
          <div
            key={piece.key}
            data-ghost={piece.fits ? "fits" : "blocked"}
            data-ghost-start={new Date(piece.startMs).toISOString()}
            data-ghost-end={new Date(piece.endMs).toISOString()}
            style={style}
            className={cn(
              "m-px overflow-hidden rounded-md border-2 border-dashed px-1.5 py-0.5 text-xs font-medium leading-tight",
              piece.fits
                ? "border-emerald-700 bg-emerald-50/80 text-emerald-900"
                : "border-rose-600 bg-rose-50/80 text-rose-900",
            )}
          >
            {piece.label}
          </div>
        );
      })}
    </div>
  );
}

export interface WeekGridProps {
  days: Date[];
  axis: AxisRow[];
  matrix: (CellView | null)[][];
  /** The axis rows drawn: the open-hours window or the full day. */
  rows: RowWindow;
  /** Busy and picked runs, drawn as one labelled overlay each. */
  blocks: readonly GridBlock[];
  /** Per day, the whole sessions its free time holds ("N fit"). Absent on a read-only grid. */
  dayFits?: readonly number[];
  /** The hover preview; empty when there is nothing to place. */
  ghost: readonly GhostPiece[];
  /** The atom under the pointer or focus, or null once both leave the grid. */
  onPreview: (startMs: number | null) => void;
  /** Index of today's column, or -1. */
  todayIndex: number;
  inPeriodDays: boolean[];
  /** The atom holding now and how far into it, for the now-line. */
  nowAtomStartMs: number;
  nowFraction: number;
  focus: GridFocus;
  zone: string;
  readOnly: boolean;
  refreshing: boolean;
  tooltipOf: (cell: CellView) => CellTooltip | null;
  onActivate: (startMs: number) => void;
  onFocusChange: (focus: GridFocus) => void;
  onPageWeek: (direction: -1 | 1) => void;
  gridRef: (element: HTMLDivElement | null) => void;
  label: string;
}

/** Overlap detail as tooltip lines, without party identity beyond what the route allowed. */
export function overlapTooltip(
  overlapping: OverlapDetail[],
): CellTooltip | null {
  if (overlapping.length === 0) return null;
  return {
    title: overlapping[0].title,
    lines: overlapping.flatMap((appointment, index) =>
      [
        index > 0 ? appointment.title : null,
        appointment.type,
        appointment.with ? `with ${appointment.with}` : null,
      ].filter((line): line is string => Boolean(line)),
    ),
  };
}

export function WeekGrid({
  days,
  axis,
  matrix,
  rows,
  blocks,
  dayFits,
  ghost,
  onPreview,
  todayIndex,
  inPeriodDays,
  nowAtomStartMs,
  nowFraction,
  focus,
  zone,
  readOnly,
  refreshing,
  tooltipOf,
  onActivate,
  onFocusChange,
  onPageWeek,
  gridRef,
  label,
}: Readonly<WeekGridProps>) {
  const helpId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<GridFocus | null>(null);

  // One keyboard stop per drawn row, top to bottom.
  const navRows = useMemo(
    () =>
      axis.slice(rows.from, rows.to).map((axisRow, offset) => ({
        key: rowKeyOf(axisRow),
        axisIndex: rows.from + offset,
      })),
    [axis, rows.from, rows.to],
  );
  const navIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    navRows.forEach((row, index) => map.set(row.key, index));
    return map;
  }, [navRows]);

  // The roving stop must always land on a row that is drawn.
  const activeFocus = useMemo<GridFocus>(() => {
    if (navIndexOf.has(focus.rowKey)) return focus;
    return { rowKey: navRows[0]?.key ?? "", dayIndex: focus.dayIndex };
  }, [focus, navIndexOf, navRows]);

  const focusElement = useCallback((target: GridFocus) => {
    const container = containerRef.current;
    if (!container) return false;
    const element = container
      .querySelector<HTMLElement>(`[data-nav-key="${target.rowKey}"]`)
      ?.querySelector<HTMLElement>(`[data-day-index="${target.dayIndex}"]`);
    if (!element) return false;
    element.focus();
    return true;
  }, []);

  // After a week or view change the target renders later; finish the move then.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && focusElement(pending)) pendingFocusRef.current = null;
  }, [navRows, matrix, focusElement]);

  // Handlers read the latest props through a ref so the memoised cells keep
  // stable callbacks across renders.
  const latest = useRef({
    navRows,
    navIndexOf,
    onActivate,
    onFocusChange,
    onPageWeek,
    onPreview,
    activeFocus,
  });
  useEffect(() => {
    latest.current = {
      navRows,
      navIndexOf,
      onActivate,
      onFocusChange,
      onPageWeek,
      onPreview,
      activeFocus,
    };
  });

  const moveTo = useCallback(
    (target: GridFocus) => {
      latest.current.onFocusChange(target);
      if (!focusElement(target)) pendingFocusRef.current = target;
    },
    [focusElement],
  );

  const handleKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLElement>,
      rowKey: string,
      dayIndex: number,
    ) => {
      const { navRows: stops, navIndexOf: indexOf } = latest.current;
      const index = indexOf.get(rowKey) ?? 0;
      const lastDay = 6;
      const go = (nextIndex: number, nextDay: number) => {
        const clampedIndex = Math.max(0, Math.min(stops.length - 1, nextIndex));
        const row = stops[clampedIndex];
        if (!row) return;
        moveTo({
          rowKey: row.key,
          dayIndex: Math.max(0, Math.min(lastDay, nextDay)),
        });
      };
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          go(index, dayIndex + 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          go(index, dayIndex - 1);
          break;
        case "ArrowDown":
          event.preventDefault();
          go(index + 1, dayIndex);
          break;
        case "ArrowUp":
          event.preventDefault();
          go(index - 1, dayIndex);
          break;
        case "Home":
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) go(0, 0);
          else go(index, 0);
          break;
        case "End":
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) go(stops.length - 1, lastDay);
          else go(index, lastDay);
          break;
        case "PageUp":
        case "PageDown": {
          event.preventDefault();
          pendingFocusRef.current = { rowKey, dayIndex };
          latest.current.onPageWeek(event.key === "PageUp" ? -1 : 1);
          break;
        }
        case "Enter":
        case " ":
          // Buttons activate themselves on Enter/Space via click.
          break;
      }
    },
    [moveTo],
  );

  const handleFocusCell = useCallback((rowKey: string, dayIndex: number) => {
    const current = latest.current.activeFocus;
    if (current.rowKey !== rowKey || current.dayIndex !== dayIndex) {
      latest.current.onFocusChange({ rowKey, dayIndex });
    }
  }, []);

  const handleActivate = useCallback((startMs: number) => {
    latest.current.onActivate(startMs);
  }, []);

  const handlePreview = useCallback((startMs: number) => {
    latest.current.onPreview(startMs);
  }, []);

  const setContainer = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      gridRef(element);
    },
    [gridRef],
  );

  return (
    <TooltipProvider delayDuration={200}>
      {refreshing && (
        <div
          aria-hidden
          className="h-0.5 shrink-0 animate-pulse bg-primary/60"
        />
      )}
      <p id={helpId} className="sr-only">
        Use the arrow keys to move between times, Home and End to jump to the
        first or last day, Enter to choose a time, and Page Up or Page Down to
        change week.
      </p>
      <div
        ref={setContainer}
        className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin"
        onMouseLeave={() => onPreview(null)}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            onPreview(null);
          }
        }}
      >
        <div
          role="grid"
          aria-label={label}
          aria-describedby={helpId}
          aria-busy={refreshing || undefined}
          aria-multiselectable={readOnly ? undefined : true}
          aria-colcount={8}
        >
          <div
            role="row"
            className={cn(
              GRID_COLS,
              "sticky top-0 z-30 border-b-2 border-slate-300 bg-background",
            )}
          >
            <div role="columnheader" className="min-w-0">
              <span className="sr-only">Time</span>
            </div>
            {days.map((date, index) => (
              <div
                key={date.toISOString()}
                role="columnheader"
                aria-current={index === todayIndex ? "date" : undefined}
                className={cn(
                  "flex min-w-0 flex-col items-center justify-center border-l border-slate-200 px-1 text-center",
                  HEADER_HEIGHT,
                  inPeriodDays[index] && "bg-blue-50",
                  index === todayIndex && "bg-primary/10",
                )}
              >
                <div
                  className={cn(
                    "text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                    index === todayIndex && "text-primary",
                  )}
                >
                  {formatWeekdayShort(date)}
                </div>
                <div
                  className={cn(
                    "text-sm font-semibold leading-6 md:text-base",
                    index === todayIndex &&
                      "min-w-7 rounded-full bg-primary px-1.5 text-primary-foreground",
                  )}
                >
                  {formatDayOfMonth(date)}
                </div>
                {dayFits && (
                  <div
                    data-day-fit
                    className={cn(
                      "text-[11px] leading-4",
                      dayFits[index] > 0
                        ? "font-medium text-emerald-800"
                        : "text-muted-foreground",
                    )}
                  >
                    {fitLabel(dayFits[index] ?? 0)}
                  </div>
                )}
              </div>
            ))}
          </div>
          {navRows.map((navRow) => {
            const axisRow = axis[navRow.axisIndex];
            const line = matrix[navRow.axisIndex] ?? [];
            // Neighbours outside the drawn rows never join: their border closes the run.
            const above =
              navRow.axisIndex > rows.from
                ? matrix[navRow.axisIndex - 1]
                : undefined;
            const below =
              navRow.axisIndex + 1 < rows.to
                ? matrix[navRow.axisIndex + 1]
                : undefined;
            const endsHour = axisRow.minuteOfDay % 60 === 30;
            return (
              <div
                key={navRow.key}
                role="row"
                data-row={navRow.axisIndex}
                data-nav-key={navRow.key}
                className={GRID_COLS}
              >
                <div
                  role="rowheader"
                  className="flex h-6 min-w-0 items-start justify-end whitespace-nowrap pr-1 text-[11px] leading-none tabular-nums text-muted-foreground md:pr-2"
                >
                  {/* Only hours are printed; the half-hour keeps its name for screen readers. */}
                  <span
                    className={axisRow.minuteOfDay % 60 === 0 ? "" : "sr-only"}
                  >
                    {axisRow.label}
                  </span>
                </div>
                {days.map((date, dayIndex) => {
                  const cell = line[dayIndex];
                  const isFocusTarget =
                    activeFocus.rowKey === navRow.key &&
                    activeFocus.dayIndex === dayIndex;
                  if (!cell) {
                    return (
                      <SkippedCell
                        key={date.toISOString()}
                        dayIndex={dayIndex}
                        rowKey={navRow.key}
                        endsHour={endsHour}
                        isRepeat={axisRow.occurrence === 1}
                        isFocusTarget={isFocusTarget}
                        onKeyDown={handleKeyDown}
                        onFocusCell={handleFocusCell}
                      />
                    );
                  }
                  return (
                    <SlotCell
                      key={date.toISOString()}
                      cell={cell}
                      dayIndex={dayIndex}
                      rowKey={navRow.key}
                      zone={zone}
                      endsHour={endsHour}
                      joinTop={above?.[dayIndex]?.statusKey === cell.statusKey}
                      joinBottom={
                        below?.[dayIndex]?.statusKey === cell.statusKey
                      }
                      isFocusTarget={isFocusTarget}
                      nowFraction={
                        dayIndex === todayIndex &&
                        cell.startMs === nowAtomStartMs
                          ? nowFraction
                          : null
                      }
                      readOnly={readOnly}
                      tooltip={tooltipOf(cell)}
                      onActivate={handleActivate}
                      onKeyDown={handleKeyDown}
                      onFocusCell={handleFocusCell}
                      onPreview={handlePreview}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        <BlockLayer blocks={blocks} ghost={ghost} rows={rows} />
      </div>
    </TooltipProvider>
  );
}

export type { SlotStatusKey };
