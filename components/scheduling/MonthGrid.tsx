"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { calendarDateKey } from "@/lib/time/grid-zone";
import { DISPLAY_LOCALE, formatMonthLabel } from "@/lib/time/display";
import { cn } from "@/utils/tailwind";
import { PICKER_TOKENS, type PickerTheme } from "./single-time-theme";

export interface MonthGridProps {
  /** A calendar date (local noon) in the month shown. */
  month: Date;
  onMonthChange: (month: Date) => void;
  selectedKey: string | null;
  onSelect: (day: Date) => void;
  /** Today in the viewer's zone, as a calendar date. */
  today: Date;
  /** Days that cannot be chosen: past, or outside the allowed window. */
  isDisabled: (day: Date) => boolean;
  /** Days with a free time; absent while unknown, which marks nothing. */
  freeDays?: ReadonlyMap<string, boolean> | null;
  marksLoading?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  theme: PickerTheme;
  className?: string;
}

const WEEKDAYS = [
  ["Mo", "Monday"],
  ["Tu", "Tuesday"],
  ["We", "Wednesday"],
  ["Th", "Thursday"],
  ["Fr", "Friday"],
  ["Sa", "Saturday"],
  ["Su", "Sunday"],
] as const;

const dayName = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const noon = (year: number, month: number, date: number) =>
  new Date(year, month, date, 12);

const addDays = (day: Date, days: number) =>
  noon(day.getFullYear(), day.getMonth(), day.getDate() + days);

/** The same day number in another month, clamped to that month's length. */
function shiftMonth(day: Date, months: number): Date {
  const last = noon(day.getFullYear(), day.getMonth() + months + 1, 0);
  return noon(
    last.getFullYear(),
    last.getMonth(),
    Math.min(day.getDate(), last.getDate()),
  );
}

/** Monday-first weekday index, 0..6. */
const mondayIndex = (day: Date) => (day.getDay() + 6) % 7;

const sameMonth = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/**
 * A month of days as an ARIA grid with one tab stop: arrows move by day and
 * week, Home and End to the week's ends, Page Up and Page Down by month.
 * Used alone where only a date is chosen, and inside the single-time picker.
 */
export function MonthGrid({
  month,
  onMonthChange,
  selectedKey,
  onSelect,
  today,
  isDisabled,
  freeDays,
  marksLoading = false,
  canGoBack,
  canGoForward,
  theme,
  className,
}: Readonly<MonthGridProps>) {
  const tokens = PICKER_TOKENS[theme];
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const daysInMonth = noon(year, monthIndex + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) =>
    noon(year, monthIndex, i + 1),
  );
  const keys = new Set(days.map(calendarDateKey));
  const todayKey = calendarDateKey(today);

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const moveFocus = useRef(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  let rovingKey = calendarDateKey(days[0]);
  if (focusKey && keys.has(focusKey)) rovingKey = focusKey;
  else if (selectedKey && keys.has(selectedKey)) rovingKey = selectedKey;
  else if (keys.has(todayKey)) rovingKey = todayKey;

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    buttons.current.get(rovingKey)?.focus();
  }, [rovingKey]);

  const focusDay = (target: Date) => {
    moveFocus.current = true;
    setFocusKey(calendarDateKey(target));
    if (!sameMonth(target, month)) onMonthChange(target);
  };

  const onKey = (event: KeyboardEvent, day: Date) => {
    let target: Date | null = null;
    if (event.key === "ArrowLeft") target = addDays(day, -1);
    else if (event.key === "ArrowRight") target = addDays(day, 1);
    else if (event.key === "ArrowUp") target = addDays(day, -7);
    else if (event.key === "ArrowDown") target = addDays(day, 7);
    else if (event.key === "Home") target = addDays(day, -mondayIndex(day));
    else if (event.key === "End") target = addDays(day, 6 - mondayIndex(day));
    else if (event.key === "PageUp") target = shiftMonth(day, -1);
    else if (event.key === "PageDown") target = shiftMonth(day, 1);
    if (!target) return;
    event.preventDefault();
    if (!sameMonth(target, month)) {
      if (target < day && !canGoBack) return;
      if (target > day && !canGoForward) return;
    }
    focusDay(target);
  };

  const weeks: (Date | null)[][] = [];
  let week: (Date | null)[] = Array.from(
    { length: mondayIndex(days[0]) },
    () => null,
  );
  for (const day of days) {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    weeks.push([
      ...week,
      ...Array.from({ length: 7 - week.length }, () => null),
    ]);
  }

  const monthLabel = formatMonthLabel(month);
  const navClass = cn(
    "inline-flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
    tokens.navButton,
    tokens.focus,
  );

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className={cn("text-base font-semibold", tokens.heading)}>
          {monthLabel}
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={navClass}
            onClick={() => {
              if (!sameMonth(today, month)) onMonthChange(today);
              if (!isDisabled(today)) onSelect(today);
            }}
          >
            Today
          </button>
          <button
            type="button"
            className={navClass}
            aria-label="Previous month"
            disabled={!canGoBack}
            onClick={() => onMonthChange(noon(year, monthIndex - 1, 1))}
          >
            <ChevronLeft aria-hidden="true" className="h-5 w-5" />
          </button>
          <button
            type="button"
            className={navClass}
            aria-label="Next month"
            disabled={!canGoForward}
            onClick={() => onMonthChange(noon(year, monthIndex + 1, 1))}
          >
            <ChevronRight aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div role="grid" aria-label={monthLabel} className="w-full">
        <div role="row" className="mb-1 grid grid-cols-7 gap-1">
          {WEEKDAYS.map(([short, long]) => (
            <div
              key={short}
              role="columnheader"
              aria-label={long}
              className={cn("text-center text-xs font-medium", tokens.weekday)}
            >
              {short}
            </div>
          ))}
        </div>
        {weeks.map((row) => (
          <div
            key={calendarDateKey(row.find((d) => d !== null) as Date)}
            role="row"
            className="grid grid-cols-7 gap-1"
          >
            {row.map((day, index) => {
              if (!day) {
                return (
                  <div
                    key={`blank-${index}`}
                    role="gridcell"
                    aria-hidden="true"
                  />
                );
              }
              const key = calendarDateKey(day);
              const disabled = isDisabled(day);
              const selected = key === selectedKey;
              const isToday = key === todayKey;
              const free = freeDays?.get(key) === true;
              const parts = [dayName.format(day)];
              if (isToday) parts.push("today");
              if (disabled) parts.push("unavailable");
              else if (free) parts.push("has free times");
              return (
                <div key={key} role="gridcell" aria-selected={selected}>
                  <button
                    ref={(element) => {
                      if (element) buttons.current.set(key, element);
                      else buttons.current.delete(key);
                    }}
                    type="button"
                    tabIndex={key === rovingKey ? 0 : -1}
                    aria-label={parts.join(", ")}
                    aria-disabled={disabled || undefined}
                    data-free={free || undefined}
                    onKeyDown={(event) => onKey(event, day)}
                    onFocus={() => setFocusKey(key)}
                    onClick={() => {
                      if (!disabled) onSelect(day);
                    }}
                    className={cn(
                      "relative mx-auto flex h-10 w-full max-w-11 items-center justify-center rounded-full text-sm transition-colors",
                      tokens.day,
                      tokens.focus,
                      selected && tokens.daySelected,
                      !selected && disabled && tokens.dayDisabled,
                      !selected && !disabled && free && tokens.dayFree,
                      !selected && !disabled && !free && tokens.dayPlain,
                      marksLoading && !disabled && !selected && "animate-pulse",
                    )}
                  >
                    {day.getDate()}
                    {free && !selected && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current"
                      />
                    )}
                    {isToday && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full border border-dashed border-current opacity-60"
                      />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
