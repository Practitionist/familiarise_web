"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import { Check, ChevronDown } from "lucide-react";

import { NotifyWhenFreeButton } from "@/components/booking/NotifyWhenFreeButton";
import { Switch } from "@/components/ui/switch";
import { useNowTick } from "@/hooks/use-now-tick";
import { BACKUP_INTEREST_CAP } from "@/lib/booking/interest/backup-interest-list";
import {
  dayPeriodOf,
  monthSummary,
  optionsForDay,
  singleTimeLeadMs,
  takenTimes,
  takenTimesToggleLabel,
  type AvailabilityWindowRef,
  type DayOptionsInput,
  type DayPeriod,
  type PickerAudience,
  type SingleSessionOption,
  type SingleTimePurpose,
} from "@/lib/scheduling/single-session-options";
import {
  AVAILABILITY_READ_FAILED_MESSAGE,
  useAvailabilityMonth,
  type AvailabilityEvent,
} from "@/lib/scheduling/use-availability-window";
import { useJustTaken } from "@/lib/scheduling/use-just-taken";
import { DISPLAY_LOCALE, formatClockTime } from "@/lib/time/display";
import { calendarDateKey, calendarDayOf } from "@/lib/time/grid-zone";
import { canonicalZone } from "@/lib/time/viewer-zone";
import { cn } from "@/utils/tailwind";
import { MonthGrid } from "./MonthGrid";
import { PICKER_TOKENS, type PickerTheme } from "./single-time-theme";

export interface SingleTimeValue {
  startsAt: string;
  endsAt: string;
  /** A buyer's pick carries the availability row it was cut from. */
  window?: AvailabilityWindowRef;
}

export interface SingleTimePickerProps {
  /** The host whose published hours and bookings decide the times. */
  consultantId: string;
  sessionMinutes: number;
  /** The viewer's zone: every day and label is drawn in it. */
  zone: string;
  theme: PickerTheme;
  /** A buyer books inside published hours; a host may place an event outside them. */
  audience: PickerAudience;
  /** The writer the pick goes to, which sets the lead. */
  purpose: SingleTimePurpose;
  /** For a request or an allocation: whether nothing is left to pay. */
  settled?: boolean;
  allowedStart?: Date;
  allowedEnd?: Date;
  /** The viewer as a consultee, so their own busy times read taken. */
  consulteeUserId?: string;
  /** The event being placed or moved: a move frees its own sessions. */
  event?: AvailabilityEvent;
  /**
   * Starts the booking door reported as held by someone else, each with when it
   * said so; a grid read newer than that answers for the start again. A new one opens the taken list.
   */
  heldStarts?: ReadonlyMap<number, number>;
  /** The plan a "Notify me" on a taken time registers for; `onSignIn` is set for a signed-out visitor. */
  notifyPlan?: {
    planKind: "CONSULTATION" | "SUBSCRIPTION";
    planId: string;
    onSignIn?: (window: SingleTimeValue) => void;
  };
  /** A taken time to bring into view with the taken list open (back from sign-in). */
  revealTakenAt?: string | null;
  /** Set to true to send the next read past the browser cache once. */
  bypassRef?: MutableRefObject<boolean>;
  value: SingleTimeValue | null;
  onChange: (value: SingleTimeValue | null) => void;
  className?: string;
}

export const TIME_JUST_TAKEN_MESSAGE =
  "That time was just taken — pick another.";

const PERIODS: readonly DayPeriod[] = ["Morning", "Afternoon", "Evening"];

const DAY_HEADING = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const SHORT_DAY = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const keyToDay = (key: string) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
};
const monthStartOf = (day: Date) =>
  new Date(day.getFullYear(), day.getMonth(), 1, 12);
const daysOfMonth = (month: Date) =>
  Array.from(
    {
      length: new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(),
    },
    (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1, 12),
  );
const sameMonth = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

const STATE_WORDS: Record<
  PickerAudience,
  Record<SingleSessionOption["state"], string>
> = {
  buyer: {
    free: "free",
    taken: "taken",
    contended: "taken, someone else is booking it",
    "outside-hours": "outside the expert's hours",
    "too-soon": "too soon",
  },
  host: {
    free: "free",
    taken: "booked",
    contended: "taken",
    "outside-hours": "outside your hours",
    "too-soon": "too soon",
  },
};

const VISIBLE_TAG: Partial<
  Record<PickerAudience, Partial<Record<SingleSessionOption["state"], string>>>
> = {
  host: { taken: "Booked", "outside-hours": "Outside your hours" },
};

/**
 * Pick one time for one session: a month on the left, the chosen day's times
 * on the right (stacked below `md`). Controlled; the caller owns the button
 * that acts on the pick. A pick the latest read shows gone is cleared and
 * the pane says so.
 */
export function SingleTimePicker({
  consultantId,
  sessionMinutes,
  zone,
  theme,
  audience,
  purpose,
  settled = true,
  allowedStart,
  allowedEnd,
  consulteeUserId,
  event,
  heldStarts,
  notifyPlan,
  revealTakenAt = null,
  bypassRef,
  value,
  onChange,
  className,
}: Readonly<SingleTimePickerProps>) {
  const tokens = PICKER_TOKENS[theme];
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const now = useNowTick(60_000);
  const nowMs = now.getTime();
  const leadMs = singleTimeLeadMs(purpose, settled);
  const allowedStartMs = allowedStart?.getTime();
  const allowedEndMs = allowedEnd?.getTime();
  const openFromMs = Math.max(nowMs + leadMs, allowedStartMs ?? 0);
  const today = calendarDayOf(now, zone);
  const firstOpenKey = calendarDateKey(
    calendarDayOf(new Date(openFromMs), zone),
  );
  const lastOpenKey =
    allowedEndMs === undefined
      ? null
      : calendarDateKey(calendarDayOf(new Date(allowedEndMs - 1), zone));

  const valueDayKey = value
    ? calendarDateKey(calendarDayOf(new Date(value.startsAt), zone))
    : null;
  const [pickedKey, setPickedKey] = useState<string | null>(valueDayKey);
  const [shownMonth, setShownMonth] = useState<Date | null>(
    valueDayKey ? monthStartOf(keyToDay(valueDayKey)) : null,
  );
  // A pick set from outside (a restored intent) brings its day into view.
  const [syncedValueKey, setSyncedValueKey] = useState(valueDayKey);
  if (valueDayKey !== syncedValueKey) {
    setSyncedValueKey(valueDayKey);
    if (valueDayKey) {
      setPickedKey(valueDayKey);
      setShownMonth(monthStartOf(keyToDay(valueDayKey)));
    }
  }
  const month = shownMonth ?? monthStartOf(keyToDay(firstOpenKey));
  const [showOutside, setShowOutside] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [takenOpen, setTakenOpen] = useState(false);
  const takenListId = useId();
  // A start the door newly refused: say so and show the taken times.
  const [seenHeld, setSeenHeld] = useState(heldStarts);
  if (heldStarts !== seenHeld) {
    setSeenHeld(heldStarts);
    if (
      [...(heldStarts?.keys() ?? [])].some((start) => !seenHeld?.has(start))
    ) {
      setNotice(TIME_JUST_TAKEN_MESSAGE);
      setTakenOpen(true);
    }
  }
  const [syncedReveal, setSyncedReveal] = useState<string | null>(null);
  if (revealTakenAt !== syncedReveal) {
    setSyncedReveal(revealTakenAt);
    if (revealTakenAt) {
      const key = calendarDateKey(calendarDayOf(new Date(revealTakenAt), zone));
      setPickedKey(key);
      setShownMonth(monthStartOf(keyToDay(key)));
      setTakenOpen(true);
    }
  }

  const query = useAvailabilityMonth({
    consultantId,
    monthStart: month,
    timezone: mounted ? zone : null,
    consulteeUserId,
    event,
    bypassRef,
  });
  // A refusal overrides only a grid answer read before it.
  const readAt = query.dataUpdatedAt;
  const liveHeldStarts = useMemo(() => {
    const live = [...(heldStarts ?? [])]
      .filter(([, refusedAt]) => refusedAt >= readAt)
      .map(([start]) => start);
    return live.length > 0 ? new Set(live) : undefined;
  }, [heldStarts, readAt]);
  const input: DayOptionsInput = useMemo(
    () => ({
      audience,
      data: query.data,
      zone,
      sessionMinutes,
      nowMs,
      leadMs,
      heldStarts: liveHeldStarts,
      allowedStartMs,
      allowedEndMs,
    }),
    [
      audience,
      query.data,
      zone,
      sessionMinutes,
      nowMs,
      leadMs,
      liveHeldStarts,
      allowedStartMs,
      allowedEndMs,
    ],
  );
  const monthDays = useMemo(() => daysOfMonth(month), [month]);
  const summary = useMemo(
    () => (query.data ? monthSummary(monthDays, input) : null),
    [query.data, monthDays, input],
  );

  const isDisabled = useCallback(
    (day: Date) => {
      const key = calendarDateKey(day);
      return key < firstOpenKey || (lastOpenKey !== null && key > lastOpenKey);
    },
    [firstOpenKey, lastOpenKey],
  );
  const firstFreeKey = monthDays
    .map(calendarDateKey)
    .find((key) => key >= firstOpenKey && summary?.get(key) === true);
  const firstEnabledKey = monthDays
    .filter((day) => !isDisabled(day))
    .map(calendarDateKey)[0];
  const selectedKey = pickedKey ?? firstFreeKey ?? firstEnabledKey ?? null;
  const selectedDay = selectedKey ? keyToDay(selectedKey) : null;

  const options = useMemo(
    () =>
      selectedKey && query.data
        ? optionsForDay(keyToDay(selectedKey), input)
        : [],
    [selectedKey, query.data, input],
  );

  // The pick is re-read against the latest answer; a buyer's pick that is no
  // longer free, or a host's pick seen free that no longer is, is gone.
  const valueStartMs = value ? Date.parse(value.startsAt) : null;
  const valueReadable =
    valueDayKey !== null &&
    query.data !== undefined &&
    sameMonth(keyToDay(valueDayKey), month);
  const valueOption =
    valueReadable && valueStartMs !== null
      ? optionsForDay(keyToDay(valueDayKey), input).find(
          (option) => option.startMs === valueStartMs,
        )
      : undefined;
  const valueLive = valueOption?.selectable === true;
  // An availability save can re-id the row under a still-free time; the pick follows it.
  const liveWindowId = valueLive ? valueOption?.window?.id : undefined;
  const liveWindowType = valueLive ? valueOption?.window?.type : undefined;
  useEffect(() => {
    if (!value || !liveWindowId || !liveWindowType) return;
    if (
      value.window?.id === liveWindowId &&
      value.window.type === liveWindowType
    ) {
      return;
    }
    onChange({ ...value, window: { id: liveWindowId, type: liveWindowType } });
  }, [value, liveWindowId, liveWindowType, onChange]);
  const [seenLiveStart, setSeenLiveStart] = useState<number | null>(null);
  if (valueLive && valueStartMs !== seenLiveStart) {
    setSeenLiveStart(valueStartMs);
  }
  const stale =
    valueReadable &&
    !valueLive &&
    (audience === "buyer" || valueStartMs === seenLiveStart);
  const dropTaken = useCallback(() => {
    onChange(null);
    setNotice(TIME_JUST_TAKEN_MESSAGE);
    setTakenOpen(true);
  }, [onChange]);
  const justTaken = useJustTaken(
    stale && value ? [value.startsAt] : [],
    dropTaken,
  );

  const needNextMonth =
    summary !== null &&
    !monthDays.some((day) => {
      const key = calendarDateKey(day);
      return key > (selectedKey ?? "") && summary.get(key) === true;
    });
  const nextMonthKey = calendarDateKey(
    new Date(month.getFullYear(), month.getMonth() + 1, 1, 12),
  );
  const nextMonthStart = useMemo(() => keyToDay(nextMonthKey), [nextMonthKey]);
  const canGoForward = lastOpenKey === null || nextMonthKey <= lastOpenKey;
  const nextQuery = useAvailabilityMonth({
    consultantId,
    monthStart: nextMonthStart,
    timezone: mounted && needNextMonth && canGoForward ? zone : null,
    consulteeUserId,
    event,
  });
  const nextFreeKey = useMemo(() => {
    if (!summary || !selectedKey) return null;
    for (const [key, free] of summary) {
      if (key > selectedKey && free) return key;
    }
    if (!nextQuery.data) return null;
    const following = monthSummary(daysOfMonth(nextMonthStart), {
      ...input,
      data: nextQuery.data,
    });
    for (const [key, free] of following) {
      if (free && (lastOpenKey === null || key <= lastOpenKey)) return key;
    }
    return null;
  }, [
    summary,
    selectedKey,
    nextQuery.data,
    input,
    lastOpenKey,
    nextMonthStart,
  ]);

  const shown = options.filter((option) => {
    if (audience === "buyer") return option.state === "free";
    if (option.state === "outside-hours") return showOutside;
    return option.state === "free" || option.state === "taken";
  });
  const justTakenRow =
    value && justTaken.has(value.startsAt) && valueDayKey === selectedKey
      ? {
          startMs: Date.parse(value.startsAt),
          endMs: Date.parse(value.endsAt),
        }
      : null;
  const freeCount = options.filter((option) => option.state === "free").length;
  const taken = audience === "buyer" ? takenTimes(options) : [];
  const outsideCount = options.filter(
    (option) => option.state === "outside-hours",
  ).length;

  const pick = (option: SingleSessionOption) => {
    if (!option.selectable) return;
    setNotice(null);
    onChange({
      startsAt: new Date(option.startMs).toISOString(),
      endsAt: new Date(option.endMs).toISOString(),
      ...(option.window ? { window: option.window } : {}),
    });
  };
  // A pick belongs to the day on screen; moving to another day or month drops it.
  const changeMonth = (target: Date) => {
    setShownMonth(monthStartOf(target));
    setPickedKey(null);
    if (value) onChange(null);
  };
  const selectDay = (day: Date) => {
    const key = calendarDateKey(day);
    setPickedKey(key);
    if (!sameMonth(day, month)) setShownMonth(monthStartOf(day));
    if (value && key !== valueDayKey) onChange(null);
  };

  if (!mounted) {
    return (
      <div
        aria-busy="true"
        className={cn("grid gap-4 md:grid-cols-2", className)}
      >
        <div className={cn("h-72 animate-pulse rounded-xl", tokens.skeleton)} />
        <div className={cn("h-72 animate-pulse rounded-xl", tokens.skeleton)} />
      </div>
    );
  }

  const zoneName = canonicalZone(zone);
  const dayHeading = selectedDay ? DAY_HEADING.format(selectedDay) : "";
  const loading = query.isPending;
  const failed = query.isError && !query.data;
  const firstMonthKey = calendarDateKey(monthStartOf(keyToDay(firstOpenKey)));
  const canGoBack = calendarDateKey(month) > firstMonthKey;
  const timeClass = (option: SingleSessionOption, selected: boolean) =>
    cn(
      "flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors",
      tokens.focus,
      selected && tokens.timeSelected,
      !selected && option.selectable && option.state === "free" && tokens.time,
      !selected && option.state === "outside-hours" && tokens.timeOutside,
      !option.selectable && tokens.timeUnavailable,
    );

  return (
    <div
      className={cn("grid min-w-0 gap-4 md:grid-cols-2 md:gap-6", className)}
    >
      <div className={tokens.pane}>
        <MonthGrid
          month={month}
          onMonthChange={changeMonth}
          selectedKey={selectedKey}
          onSelect={selectDay}
          today={today}
          isDisabled={isDisabled}
          freeDays={summary}
          marksLoading={loading}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          theme={theme}
        />
      </div>
      <section
        className={cn(tokens.pane, "min-w-0")}
        aria-busy={loading}
        aria-label="Times"
      >
        <h3 className={cn("text-base font-semibold", tokens.heading)}>
          {dayHeading}
        </h3>
        <p className={cn("mb-3 text-xs", tokens.muted)} title={zoneName}>
          Times in {zoneName}
        </p>
        <p className="sr-only" aria-live="polite">
          {loading || failed
            ? ""
            : `${freeCount} free ${freeCount === 1 ? "time" : "times"} on ${dayHeading}`}
        </p>
        {audience === "host" && (
          <label
            className={cn(
              "mb-3 flex min-h-10 items-center justify-between gap-3 text-sm",
              tokens.heading,
            )}
          >
            <span>Show times outside my hours</span>
            <Switch checked={showOutside} onCheckedChange={setShowOutside} />
          </label>
        )}
        {notice && (
          <p
            role="status"
            className={cn(
              "mb-3 rounded-lg border px-3 py-2 text-sm",
              tokens.notice,
            )}
          >
            {notice}
          </p>
        )}
        {loading && (
          <div className="space-y-2" data-testid="times-skeleton">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className={cn("h-10 animate-pulse rounded-lg", tokens.skeleton)}
              />
            ))}
          </div>
        )}
        {failed && (
          <div role="alert" className="space-y-3 py-4 text-center">
            <p className={cn("text-sm", tokens.heading)}>
              {AVAILABILITY_READ_FAILED_MESSAGE}
            </p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className={cn(
                "inline-flex min-h-10 items-center rounded-lg border px-4 text-sm font-medium",
                tokens.time,
                tokens.focus,
              )}
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !failed && (
          <div className="max-h-[22rem] space-y-4 overflow-y-auto pr-1">
            {freeCount === 0 && (
              <div className="space-y-2 py-2">
                <p className={cn("text-sm", tokens.heading)}>
                  No free times on this day
                </p>
                {nextFreeKey && (
                  <button
                    type="button"
                    onClick={() => selectDay(keyToDay(nextFreeKey))}
                    className={cn(
                      "inline-flex min-h-10 items-center rounded-lg border px-4 text-sm font-medium",
                      tokens.time,
                      tokens.focus,
                    )}
                  >
                    Next free: {SHORT_DAY.format(keyToDay(nextFreeKey))}
                  </button>
                )}
              </div>
            )}
            {PERIODS.map((period) => {
              const rows = shown.filter(
                (option) => dayPeriodOf(option.startMs, zone) === period,
              );
              const ghost =
                justTakenRow &&
                dayPeriodOf(justTakenRow.startMs, zone) === period
                  ? justTakenRow
                  : null;
              if (rows.length === 0 && !ghost) return null;
              return (
                <div key={period} role="group" aria-label={period}>
                  <p
                    className={cn(
                      "mb-2 text-xs font-medium uppercase tracking-wide",
                      tokens.muted,
                    )}
                  >
                    {period}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {ghost && (
                      <div
                        data-just-taken="true"
                        aria-label={`${formatClockTime(new Date(ghost.startMs), { zone })} to ${formatClockTime(new Date(ghost.endMs), { zone })}, just taken`}
                        className={cn(
                          "flex min-h-10 items-center justify-between rounded-lg border px-3 py-2 text-sm line-through",
                          tokens.timeUnavailable,
                        )}
                      >
                        <span>
                          {formatClockTime(new Date(ghost.startMs), { zone })}
                        </span>
                        <span className="text-xs no-underline">Just taken</span>
                      </div>
                    )}
                    {rows.map((option) => {
                      const selected =
                        value !== null && valueStartMs === option.startMs;
                      const start = formatClockTime(new Date(option.startMs), {
                        zone,
                      });
                      const end = formatClockTime(new Date(option.endMs), {
                        zone,
                      });
                      const tag = VISIBLE_TAG[audience]?.[option.state];
                      return (
                        <div key={option.startMs} className="space-y-1">
                          <button
                            type="button"
                            aria-pressed={selected}
                            aria-disabled={!option.selectable || undefined}
                            aria-label={`${start} to ${end}, ${STATE_WORDS[audience][option.state]}`}
                            data-state={option.state}
                            onClick={() => pick(option)}
                            className={timeClass(option, selected)}
                          >
                            <span>{start}</span>
                            {selected ? (
                              <Check aria-hidden="true" className="h-4 w-4" />
                            ) : (
                              tag && <span className="text-xs">{tag}</span>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {taken.length > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  aria-expanded={takenOpen}
                  aria-controls={takenListId}
                  onClick={() => setTakenOpen((open) => !open)}
                  className={cn(
                    "inline-flex min-h-10 items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 hover:underline",
                    tokens.heading,
                    tokens.focus,
                  )}
                >
                  {takenTimesToggleLabel(taken.length, takenOpen)}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "h-4 w-4 transition-transform",
                      takenOpen && "rotate-180",
                    )}
                  />
                </button>
                {takenOpen && (
                  <div id={takenListId} className="space-y-2">
                    {notifyPlan && (
                      <p className={cn("text-xs", tokens.muted)}>
                        You can wait on up to {BACKUP_INTEREST_CAP} times.
                      </p>
                    )}
                    <ul className="space-y-2">
                      {taken.map((option) => {
                        const start = formatClockTime(
                          new Date(option.startMs),
                          { zone },
                        );
                        const end = formatClockTime(new Date(option.endMs), {
                          zone,
                        });
                        const takenSlot: SingleTimeValue = {
                          startsAt: new Date(option.startMs).toISOString(),
                          endsAt: new Date(option.endMs).toISOString(),
                        };
                        const onSignIn = notifyPlan?.onSignIn;
                        return (
                          <li
                            key={option.startMs}
                            data-state={option.state}
                            className={cn(
                              "flex min-h-10 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                              tokens.takenRow,
                            )}
                          >
                            <span>
                              {start} to {end}
                              <span className="sr-only">
                                , {STATE_WORDS.buyer[option.state]}
                              </span>
                            </span>
                            {notifyPlan && (
                              <NotifyWhenFreeButton
                                window={{
                                  consultantProfileId: consultantId,
                                  windowStart: takenSlot.startsAt,
                                  windowEnd: takenSlot.endsAt,
                                  planKind: notifyPlan.planKind,
                                  planId: notifyPlan.planId,
                                }}
                                timeLabel={start}
                                onSignIn={
                                  onSignIn
                                    ? () => onSignIn(takenSlot)
                                    : undefined
                                }
                                errorClassName={tokens.error}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {audience === "host" && !showOutside && outsideCount > 0 && (
              <p className={cn("text-xs", tokens.muted)}>
                {outsideCount} more{" "}
                {outsideCount === 1 ? "time is" : "times are"} outside your
                hours.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
