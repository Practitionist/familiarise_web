"use client";

import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { addDays, endOfMonth, startOfMonth, subMonths } from "date-fns";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  calendarDateKey,
  calendarDayOf,
  dayStartInstant,
} from "@/lib/time/grid-zone";
import { cn } from "@/utils/tailwind";
import { FilterPill, filterTriggerClass } from "./FilterPill";

/** Inclusive calendar days as `YYYY-MM-DD`; an empty side is open-ended. */
export interface DateRange {
  from: string;
  to: string;
}

/** Which presets fit the list: coming-up sessions, past ones, or both. */
export type DateRangeDirection = "future" | "past" | "any";

interface Preset {
  label: string;
  range: DateRange;
}

const EMPTY: DateRange = { from: "", to: "" };

/** The local-noon calendar date of a `YYYY-MM-DD` key, `offset` days on. */
function calendarDateOf(iso: string, offset = 0): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + offset, 12);
}

/** The range as epoch-ms bounds of whole calendar days in `zone`; an empty side is null. */
export function dateRangeBounds(
  range: DateRange,
  zone: string,
): { fromMs: number | null; toMs: number | null } {
  return {
    fromMs: range.from
      ? dayStartInstant(calendarDateOf(range.from), zone).getTime()
      : null,
    toMs: range.to
      ? dayStartInstant(calendarDateOf(range.to, 1), zone).getTime() - 1
      : null,
  };
}

/** Presets on the viewer's calendar; both ends are inclusive, so "Next 7 days" is today plus six. */
export function datePresets(
  direction: DateRangeDirection,
  zone: string,
  now: Date = new Date(),
): Preset[] {
  const today = calendarDayOf(now, zone);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const day = (from: Date, to: Date) => ({
    from: calendarDateKey(from),
    to: calendarDateKey(to),
  });
  const todayP = { label: "Today", range: day(today, today) };
  const thisWeek = {
    label: "This week",
    range: day(monday, addDays(monday, 6)),
  };
  const thisMonth = {
    label: "This month",
    range: day(startOfMonth(today), endOfMonth(today)),
  };
  if (direction === "future") {
    return [
      todayP,
      { label: "Tomorrow", range: day(addDays(today, 1), addDays(today, 1)) },
      thisWeek,
      { label: "Next 7 days", range: day(today, addDays(today, 6)) },
      { label: "Next 30 days", range: day(today, addDays(today, 29)) },
    ];
  }
  if (direction === "past") {
    return [
      todayP,
      { label: "Last 7 days", range: day(addDays(today, -6), today) },
      { label: "Last 30 days", range: day(addDays(today, -29), today) },
      thisMonth,
      // Calendar months; date-fns clamps 31 May back to 28 Feb.
      { label: "Last 3 months", range: day(subMonths(today, 3), today) },
    ];
  }
  return [todayP, thisWeek, thisMonth];
}

function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

/** The trigger text: a preset's name, else the custom range in short form. */
export function dateRangeLabel(range: DateRange, presets: Preset[]): string {
  if (!range.from && !range.to) return "Any date";
  const preset = presets.find(
    (p) => p.range.from === range.from && p.range.to === range.to,
  );
  if (preset) return preset.label;
  if (range.from && range.to) {
    return range.from === range.to
      ? shortDay(range.from)
      : `${shortDay(range.from)} – ${shortDay(range.to)}`;
  }
  return range.from
    ? `From ${shortDay(range.from)}`
    : `Until ${shortDay(range.to)}`;
}

interface DateRangeMenuProps {
  value: DateRange;
  /** The viewer's IANA zone; presets and bounds count its calendar days. */
  zone: string;
  onChange: (value: DateRange) => void;
  direction?: DateRangeDirection;
}

/** A date filter as one button: quick presets plus a custom range. */
export function DateRangeMenu({
  value,
  onChange,
  zone,
  direction = "any",
}: Readonly<DateRangeMenuProps>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const presets = datePresets(direction, zone);
  const active = value.from !== "" || value.to !== "";
  const label = dateRangeLabel(value, presets);
  const isPreset = presets.some(
    (p) => p.range.from === value.from && p.range.to === value.to,
  );
  const [customOpen, setCustomOpen] = useState(false);
  const invalid = draft.from !== "" && draft.to !== "" && draft.from > draft.to;

  const pick = (range: DateRange) => {
    onChange(range);
    setOpen(false);
  };

  return (
    <FilterPill
      active={active}
      clearLabel="Clear date filter"
      onClear={() => onChange(EMPTY)}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setDraft(value);
            setCustomOpen(active && !isPreset);
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Date: ${label}`}
            className={filterTriggerClass(active)}
          >
            <CalendarDays
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <span className={cn(active && "font-semibold")}>{label}</span>
            {!active && (
              <ChevronDown
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-1" aria-label="Date">
          <fieldset aria-label="Date" className="m-0 min-w-0 border-0 p-0">
            {[{ label: "Any date", range: EMPTY }, ...presets].map((p) => {
              const selected =
                p.range.from === value.from && p.range.to === value.to;
              return (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(p.range)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    selected && "font-semibold",
                  )}
                >
                  <span className="flex-1">{p.label}</span>
                  <Check
                    className={cn("h-3.5 w-3.5", !selected && "invisible")}
                    aria-hidden
                  />
                </button>
              );
            })}
          </fieldset>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
              active && !isPreset && "font-semibold",
            )}
          >
            <span className="flex-1">Custom range…</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                customOpen && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          {customOpen && (
            <form
              className="space-y-2 px-2.5 pb-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!invalid) pick(draft);
              }}
            >
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                From
                <Input
                  type="date"
                  value={draft.from}
                  max={draft.to || undefined}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                  className="h-8 w-[150px] px-2 text-xs"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                To
                <Input
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  className="h-8 w-[150px] px-2 text-xs"
                />
              </label>
              <Button
                type="submit"
                size="sm"
                className="h-8 w-full"
                disabled={invalid || (draft.from === "" && draft.to === "")}
              >
                Apply
              </Button>
            </form>
          )}
        </PopoverContent>
      </Popover>
    </FilterPill>
  );
}
