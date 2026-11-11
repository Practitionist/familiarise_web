"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNowTick } from "@/hooks/use-now-tick";
import {
  eventLeadMs,
  type EventTimePurpose,
} from "@/lib/booking/event-time-rules";
import { dayListBounds, dayListDates } from "@/lib/scheduling/day-list";
import {
  atomIndex,
  singleSessionOptions,
  SINGLE_SESSION_STATE_LABEL,
  type SingleSessionOption,
} from "@/lib/scheduling/single-session-options";
import {
  useAvailabilityWindow,
  type AvailabilityEvent,
} from "@/lib/scheduling/use-availability-window";
import {
  calendarDateKey,
  calendarDayOf,
  dayRangeBounds,
} from "@/lib/time/grid-zone";
import {
  formatClockTime,
  formatDayOfMonth,
  formatWeekdayShort,
} from "@/lib/time/display";
import { cn } from "@/utils/tailwind";

export interface SingleSessionPickerProps {
  /** The host whose published hours and bookings label the times. */
  consultantId: string;
  /** The host's zone: days, labels and the half-hour list are in it. */
  zone: string;
  sessionMinutes: number;
  /** Decides the lead: an hour to publish or make up, 24 hours to move a sold event. */
  purpose: EventTimePurpose;
  /** The window a start must sit in (a make-up's 14 days); open when absent. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** The event being placed: its co-hosts' time counts, and a move frees its own sessions. */
  event?: AvailabilityEvent;
  /** The chosen start, ISO, or null. */
  value: string | null;
  onChange: (startsAt: string | null) => void;
  className?: string;
}

const ARROW_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

const STATE_CLASS: Record<SingleSessionOption["state"], string> = {
  free: "border-emerald-600 bg-emerald-50 text-emerald-950 hover:bg-emerald-100",
  outsideHours: "border-border bg-background text-foreground hover:bg-muted",
  busy: "border-slate-300 bg-slate-100 text-slate-500 line-through",
  tooSoon: "border-dashed border-slate-300 text-slate-400",
  outsideWindow: "border-dashed border-slate-300 text-slate-400",
};

/**
 * One start time for one session, for a host: a strip of days, then every
 * half-hour start that day, each labelled Free (inside published hours and
 * unbooked), Outside your hours (allowed for an event), Busy or Too soon. It
 * replaces the bare date-time inputs of the webinar editor, the re-time
 * dialog and the class make-up, and works the same on a phone.
 */
export function SingleSessionPicker({
  consultantId,
  zone,
  sessionMinutes,
  purpose,
  allowedStart,
  allowedEnd,
  event,
  value,
  onChange,
  className,
}: Readonly<SingleSessionPickerProps>) {
  const now = useNowTick(60_000);
  const notBeforeMs = now.getTime() + eventLeadMs(purpose);
  const openFromMs = Math.max(notBeforeMs, allowedStart?.getTime() ?? 0);
  const [page, setPage] = useState(0);
  const days = useMemo(
    () => dayListDates(openFromMs + page * 14 * 86_400_000, zone),
    [openFromMs, page, zone],
  );
  const bounds = useMemo(
    () => dayListBounds(openFromMs + page * 14 * 86_400_000, zone),
    [openFromMs, page, zone],
  );
  const initialDay = value
    ? calendarDateKey(calendarDayOf(new Date(value), zone))
    : calendarDateKey(days[0]);
  const [dayKey, setDayKey] = useState(initialDay);
  const selectedDay =
    days.find((day) => calendarDateKey(day) === dayKey) ?? days[0];

  const availability = useAvailabilityWindow({
    consultantId,
    startUtc: bounds.start,
    endUtc: bounds.end,
    timezone: zone,
    event,
    keepPrevious: true,
  });
  const atoms = useMemo(
    () => atomIndex(availability.data),
    [availability.data],
  );
  const dayBounds = dayRangeBounds(selectedDay, selectedDay, zone);
  const options = singleSessionOptions({
    atoms,
    dayStartMs: dayBounds.start.getTime(),
    dayEndMs: dayBounds.end.getTime(),
    sessionMinutes,
    notBeforeMs,
    allowedStartMs: allowedStart?.getTime(),
    allowedEndMs: allowedEnd?.getTime(),
  });
  const pickable = options.filter((option) => option.state !== "outsideWindow");
  const isoOf = (option: SingleSessionOption) =>
    new Date(option.startMs).toISOString();
  // One tab stop for the time radios: the chosen time, else the first one that can be picked.
  const choosable = pickable.filter((option) => option.selectable);
  const tabStopMs = (
    choosable.find((option) => isoOf(option) === value) ??
    choosable[0] ??
    pickable[0]
  )?.startMs;
  const timeButtons = useRef(new Map<number, HTMLButtonElement>());
  const onTimeKey = (event: KeyboardEvent, option: SingleSessionOption) => {
    const at = choosable.findIndex((o) => o.startMs === option.startMs);
    if (at < 0 || choosable.length === 0) return;
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = choosable.length - 1;
    else if (event.key in ARROW_STEP) {
      next = (at + ARROW_STEP[event.key] + choosable.length) % choosable.length;
    } else return;
    event.preventDefault();
    const target = choosable[next];
    onChange(isoOf(target));
    timeButtons.current.get(target.startMs)?.focus();
  };
  const canNext =
    allowedEnd === undefined || bounds.end.getTime() < allowedEnd.getTime();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Earlier days"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div
          role="radiogroup"
          aria-label="Day"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          {days.map((day) => {
            const key = calendarDateKey(day);
            const active = key === calendarDateKey(selectedDay);
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setDayKey(key)}
                className={cn(
                  "min-w-[3.25rem] rounded-md border px-2 py-1 text-center text-xs",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-muted",
                )}
              >
                <span className="block font-medium">
                  {formatWeekdayShort(day)}
                </span>
                <span className="block">{formatDayOfMonth(day)}</span>
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Later days"
          disabled={!canNext}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {availability.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading your
          calendar…
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Start time"
          className="grid max-h-72 grid-cols-3 gap-1 overflow-y-auto sm:grid-cols-4"
        >
          {pickable.map((option) => {
            const iso = isoOf(option);
            const chosen = value === iso;
            const label = `${formatClockTime(new Date(option.startMs), { zone })}`;
            return (
              <button
                key={option.startMs}
                ref={(element) => {
                  if (element) timeButtons.current.set(option.startMs, element);
                  else timeButtons.current.delete(option.startMs);
                }}
                type="button"
                role="radio"
                aria-checked={chosen}
                tabIndex={option.startMs === tabStopMs ? 0 : -1}
                onKeyDown={(event) => onTimeKey(event, option)}
                aria-disabled={!option.selectable || undefined}
                aria-label={`${label}, ${SINGLE_SESSION_STATE_LABEL[option.state]}`}
                title={SINGLE_SESSION_STATE_LABEL[option.state]}
                onClick={() => {
                  if (option.selectable && !chosen) onChange(iso);
                }}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-left text-xs",
                  STATE_CLASS[option.state],
                  !option.selectable && "cursor-not-allowed",
                  chosen &&
                    "border-primary bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                <span className="block font-medium">{label}</span>
                <span className="block text-[11px] opacity-80">
                  {SINGLE_SESSION_STATE_LABEL[option.state]}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Times are in {zone}. Free means inside your published hours with nothing
        booked; you can still run an event outside your hours. Each session
        lasts {sessionMinutes} minutes.
      </p>
    </div>
  );
}
