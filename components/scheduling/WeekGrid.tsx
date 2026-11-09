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
import type {
  CellView,
  OverlapDetail,
  RowWindow,
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

// A fixed time gutter and seven shrinkable day columns.
export const GRID_COLS =
  "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] md:grid-cols-[5rem_repeat(7,minmax(0,1fr))]";

/** The roving-focus key of an axis row. */
export function rowKeyOf(axisRow: AxisRow): string {
  return `row:${axisRow.key}`;
}

export interface GridFocus {
  rowKey: string;
  dayIndex: number;
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
}

function NowLine({ fraction }: Readonly<{ fraction: number }>) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-primary"
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
    a.cell.text === b.cell.text &&
    a.cell.stateLabel === b.cell.stateLabel &&
    a.cell.isRequested === b.cell.isRequested &&
    a.dayIndex === b.dayIndex &&
    a.rowKey === b.rowKey &&
    a.zone === b.zone &&
    a.isFocusTarget === b.isFocusTarget &&
    a.nowFraction === b.nowFraction &&
    a.readOnly === b.readOnly &&
    sameTooltip(a.tooltip, b.tooltip) &&
    a.onActivate === b.onActivate &&
    a.onKeyDown === b.onKeyDown &&
    a.onFocusCell === b.onFocusCell
  );
}

const SlotCell = memo(function SlotCell({
  cell,
  dayIndex,
  rowKey,
  zone,
  isFocusTarget,
  nowFraction,
  readOnly,
  tooltip,
  onActivate,
  onKeyDown,
  onFocusCell,
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
          readOnly && "cursor-default",
          cell.isRequested && REQUESTED_OUTLINE.className,
        ),
      })}
      onClick={() => onActivate(cell.startMs)}
      onKeyDown={(event) => onKeyDown(event, rowKey, dayIndex)}
      onFocus={() => onFocusCell(rowKey, dayIndex)}
    >
      <SlotStatusIcon name={token.icon} />
      {cell.text && <span className="truncate">{cell.text}</span>}
    </button>
  );
  return (
    <div
      role="gridcell"
      aria-selected={interactive ? cell.statusKey === "selected" : undefined}
      className="relative min-w-0"
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
  isRepeat,
  isFocusTarget,
  onKeyDown,
  onFocusCell,
}: Readonly<{
  dayIndex: number;
  rowKey: string;
  /** The row is another day's repeated fall-back hour, not a time this day skips. */
  isRepeat: boolean;
  isFocusTarget: boolean;
  onKeyDown: SlotCellProps["onKeyDown"];
  onFocusCell: SlotCellProps["onFocusCell"];
}>) {
  return (
    <div role="gridcell" className="relative min-w-0">
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
        className="h-7 w-full cursor-not-allowed rounded-sm border border-dashed border-transparent"
        onKeyDown={(event) => onKeyDown(event, rowKey, dayIndex)}
        onFocus={() => onFocusCell(rowKey, dayIndex)}
      />
    </div>
  );
});

export interface WeekGridProps {
  days: Date[];
  axis: AxisRow[];
  matrix: (CellView | null)[][];
  /** The axis rows drawn: the open-hours window or the full day. */
  rows: RowWindow;
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
    activeFocus,
  });
  useEffect(() => {
    latest.current = {
      navRows,
      navIndexOf,
      onActivate,
      onFocusChange,
      onPageWeek,
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
        role="grid"
        aria-label={label}
        aria-describedby={helpId}
        aria-busy={refreshing || undefined}
        aria-multiselectable={readOnly ? undefined : true}
        aria-colcount={8}
        className="relative flex-1 overflow-y-auto scrollbar-thin min-h-0"
      >
        <div
          role="row"
          className={cn(
            GRID_COLS,
            "sticky top-0 z-20 gap-0.5 bg-background pb-1 md:gap-1",
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
                "min-w-0 rounded-sm p-1 text-center md:p-2",
                inPeriodDays[index] && "border-x-2 border-blue-200 bg-blue-50",
                index === todayIndex && "bg-primary/10 ring-1 ring-primary/40",
              )}
            >
              <div
                className={cn(
                  "text-xs font-bold md:text-base",
                  index === todayIndex && "text-primary",
                )}
              >
                {formatWeekdayShort(date)}
              </div>
              <div className="text-xs text-muted-foreground md:text-sm">
                {formatDayOfMonth(date)}
              </div>
            </div>
          ))}
        </div>
        {navRows.map((navRow) => {
          const axisRow = axis[navRow.axisIndex];
          const line = matrix[navRow.axisIndex] ?? [];
          return (
            <div
              key={navRow.key}
              role="row"
              data-row={navRow.axisIndex}
              data-nav-key={navRow.key}
              className={cn(
                GRID_COLS,
                "gap-0.5 border-b border-border/40 md:gap-1",
              )}
            >
              <div
                role="rowheader"
                className="flex h-7 min-w-0 items-start justify-end whitespace-nowrap pr-1 text-[10px] tabular-nums text-muted-foreground md:pr-2 md:text-xs"
              >
                {axisRow.label}
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
                    isFocusTarget={isFocusTarget}
                    nowFraction={
                      dayIndex === todayIndex && cell.startMs === nowAtomStartMs
                        ? nowFraction
                        : null
                    }
                    readOnly={readOnly}
                    tooltip={tooltipOf(cell)}
                    onActivate={handleActivate}
                    onKeyDown={handleKeyDown}
                    onFocusCell={handleFocusCell}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export type { SlotStatusKey };
