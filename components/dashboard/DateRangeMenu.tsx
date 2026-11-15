"use client";

import { CalendarDays, Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/utils/tailwind";

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

function isoDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function localDay(iso: string, shift = 0): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + shift);
}

/**
 * A picked range as instants for an API: `from` is local midnight of the first
 * day, `to` the last millisecond of the last day. `new Date("YYYY-MM-DD")` is
 * UTC midnight, which drops the last day and shifts the first by the zone offset.
 */
export function dateRangeToInstants(range: DateRange): {
  from: Date | null;
  to: Date | null;
} {
  return {
    from: range.from ? localDay(range.from) : null,
    to: range.to ? new Date(localDay(range.to, 1).getTime() - 1) : null,
  };
}

/** Presets in the browser's calendar, matching the native date inputs they replace. */
export function datePresets(
  direction: DateRangeDirection,
  now: Date = new Date(),
): Preset[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const day = (from: Date, to: Date) => ({
    from: isoDay(from),
    to: isoDay(to),
  });
  const todayP = { label: "Today", range: day(today, today) };
  const thisWeek = {
    label: "This week",
    range: day(monday, addDays(monday, 6)),
  };
  const thisMonth = {
    label: "This month",
    range: day(
      new Date(today.getFullYear(), today.getMonth(), 1),
      new Date(today.getFullYear(), today.getMonth() + 1, 0),
    ),
  };
  if (direction === "future") {
    return [
      todayP,
      { label: "Tomorrow", range: day(addDays(today, 1), addDays(today, 1)) },
      thisWeek,
      { label: "Next 7 days", range: day(today, addDays(today, 7)) },
      { label: "Next 30 days", range: day(today, addDays(today, 30)) },
    ];
  }
  if (direction === "past") {
    return [
      todayP,
      { label: "Last 7 days", range: day(addDays(today, -7), today) },
      { label: "Last 30 days", range: day(addDays(today, -30), today) },
      thisMonth,
      { label: "Last 3 months", range: day(addDays(today, -90), today) },
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

const TRIGGER =
  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface DateRangeMenuProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  direction?: DateRangeDirection;
}

/** A date filter as one button: quick presets plus a custom range. */
export function DateRangeMenu({
  value,
  onChange,
  direction = "any",
}: Readonly<DateRangeMenuProps>) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const presets = datePresets(direction);
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
    <div className="inline-flex">
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
            className={cn(
              TRIGGER,
              active
                ? "rounded-l-lg border-foreground bg-foreground pl-3 pr-2 text-background"
                : "rounded-lg border-border bg-card px-3 text-foreground hover:border-foreground/30",
            )}
          >
            <CalendarDays
              className={cn("h-4 w-4", !active && "text-muted-foreground")}
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
        <PopoverContent className="w-64 p-1">
          <div role="group" aria-label="Date">
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
          </div>
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
      {active && (
        <button
          type="button"
          aria-label="Clear date filter"
          onClick={() => onChange(EMPTY)}
          className={cn(
            TRIGGER,
            "rounded-r-lg border-l-0 border-foreground bg-foreground pl-1 pr-2.5 text-background/70 hover:text-background",
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
