"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";

import { useAvailabilityWindow } from "@/lib/scheduling/use-availability-window";
import { useNowTick } from "@/hooks/use-now-tick";
import {
  buildDayList,
  dayListBounds,
  pickConflict,
  pickLabel,
  stalePicks,
  type DayListPick,
  type DayListRules,
} from "@/lib/scheduling/day-list";
import { SLOT_STATUS_TOKENS } from "@/lib/scheduling/interval-status-tokens";
import { useJustTaken } from "@/lib/scheduling/use-just-taken";
import { cn } from "@/utils/tailwind";

export interface MobileDayListPickerProps {
  consultantId: string;
  consulteeUserId?: string;
  /** The subscription being moved, so the plan's limits show. */
  subscriptionId?: string;
  /** Sessions being moved; the limit overlay counts them as free. */
  releasingIds?: readonly string[];
  /** The plan's per-day session cap and the zone its days are counted in. */
  dayCap?: { perDay: number; zone: string };
  /** Display zone (already resolved). */
  zone: string;
  /** Length of each time to pick (multiple of 30). */
  sessionMinutes: number;
  /** How many sessions need a time. */
  timesNeeded: number;
  /** Selectable window (inclusive start). */
  allowedStart?: Date;
  /** Selectable window (inclusive end of the last session). */
  allowedEnd?: Date;
  /** Extra notice on top of the server's 15-min tooSoon. */
  minLeadHours?: number;
  /** Whole-session picks, ISO. */
  value: DayListPick[];
  onChange: (next: DayListPick[]) => void;
  className?: string;
}

const JUST_TAKEN = SLOT_STATUS_TOKENS.justTaken;

function timesWord(count: number): string {
  return `${count} time${count === 1 ? "" : "s"}`;
}

/**
 * The consultee's picker below `md`: a row of day chips over the next two
 * weeks and the session starts each day offers, read from the same grid
 * endpoint as the desktop heat map. The host's footer owns "Any time works"
 * and submit; this component only edits `value`.
 */
export function MobileDayListPicker({
  consultantId,
  consulteeUserId,
  subscriptionId,
  releasingIds,
  dayCap,
  zone,
  sessionMinutes,
  timesNeeded,
  allowedStart,
  allowedEnd,
  minLeadHours,
  value,
  onChange,
  className,
}: Readonly<MobileDayListPickerProps>) {
  const now = useNowTick(60_000);
  const nowMs = now.getTime();
  const bounds = dayListBounds(nowMs, zone);
  const startIso = bounds.start.toISOString();
  const endIso = bounds.end.toISOString();
  const range = useMemo(
    () => ({ start: new Date(startIso), end: new Date(endIso) }),
    [startIso, endIso],
  );
  const query = useAvailabilityWindow({
    consultantId,
    startUtc: range.start,
    endUtc: range.end,
    timezone: zone,
    consulteeUserId,
    subscriptionId,
    releasingIds,
    // Midnight moves the window; keep the list instead of a skeleton.
    keepPrevious: true,
  });

  const allowedStartMs = allowedStart?.getTime();
  const allowedEndMs = allowedEnd?.getTime();
  const rules = useMemo<DayListRules>(
    () => ({
      zone,
      sessionMinutes,
      nowMs,
      allowedStart:
        allowedStartMs === undefined ? undefined : new Date(allowedStartMs),
      allowedEnd:
        allowedEndMs === undefined ? undefined : new Date(allowedEndMs),
      minLeadHours,
    }),
    [zone, sessionMinutes, nowMs, allowedStartMs, allowedEndMs, minLeadHours],
  );
  const days = useMemo(
    () => (query.data ? buildDayList(query.data, rules) : []),
    [query.data, rules],
  );

  // A poll that takes a pick paints it "Just taken" once, then drops it.
  const [announcement, setAnnouncement] = useState("");
  const stale = query.data ? stalePicks(value, query.data, rules) : [];
  const dropTaken = useCallback(
    (keys: string[]) => {
      const gone = value.filter((pick) => keys.includes(pick.startsAt));
      if (gone.length === 0) return;
      onChange(value.filter((pick) => !keys.includes(pick.startsAt)));
      setAnnouncement(
        gone.length === 1
          ? `${pickLabel(gone[0], zone)} is no longer free, so we removed it. Pick another time.`
          : `${gone.length} of your times are no longer free, so we removed them. Pick other times.`,
      );
    },
    [value, onChange, zone],
  );
  const justTaken = useJustTaken(stale, dropTaken);

  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const activeDay =
    days.find((day) => day.key === chosenKey) ??
    days.find((day) => day.starts.length > 0) ??
    days[0];

  const pickedStarts = new Set(value.map((pick) => pick.startsAt));
  const full = value.length >= timesNeeded;

  const toggle = (pick: DayListPick) => {
    setAnnouncement("");
    if (pickedStarts.has(pick.startsAt)) {
      onChange(value.filter((p) => p.startsAt !== pick.startsAt));
      return;
    }
    if (full || pickConflict(pick, value, dayCap)) return;
    onChange(
      [...value, { startsAt: pick.startsAt, endsAt: pick.endsAt }].sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ),
    );
  };

  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onChipKeyDown = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    for (
      let next = index + step;
      next >= 0 && next < days.length;
      next += step
    ) {
      if (days[next].starts.length > 0) {
        setChosenKey(days[next].key);
        chipRefs.current[next]?.focus();
        return;
      }
    }
  };

  const status = `${value.length} of ${timesWord(timesNeeded)} picked`;
  const firstLoad = query.data === undefined;

  return (
    <div className={cn("space-y-4", className)} data-testid="mobile-day-list">
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {status}
        {announcement && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="text-foreground">{announcement}</span>
          </>
        )}
      </p>

      {firstLoad && query.isError ? (
        <div role="alert" className="rounded-lg border p-4 text-sm">
          <p>We couldn&apos;t load the available times.</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-2 font-medium underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      ) : firstLoad ? (
        <div aria-busy="true" aria-label="Loading times" className="space-y-3">
          <div className="flex gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className="h-14 w-12 shrink-0 animate-pulse rounded-lg bg-muted"
              />
            ))}
          </div>
          <div className="h-10 animate-pulse rounded-lg bg-muted" />
          <div className="h-10 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label="Day"
            className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
          >
            {days.map((day, index) => {
              const checked = day.key === activeDay?.key;
              const count = day.starts.length;
              return (
                <button
                  key={day.key}
                  ref={(node) => {
                    chipRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={`${day.label}, ${count === 0 ? "no free times" : `${timesWord(count)} free`}`}
                  disabled={count === 0}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setChosenKey(day.key)}
                  onKeyDown={(event) => onChipKeyDown(event, index)}
                  className={cn(
                    "flex w-14 shrink-0 flex-col items-center rounded-lg border px-1 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    checked
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-foreground",
                    count === 0 && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span>{day.weekday}</span>
                  <span className="text-base font-semibold">
                    {day.dayOfMonth}
                  </span>
                  <span aria-hidden="true">{count}</span>
                </button>
              );
            })}
          </div>

          {activeDay && activeDay.starts.length > 0 ? (
            <ul
              aria-label={`Times on ${activeDay.label}`}
              className="space-y-2"
            >
              {activeDay.starts.map((start) => {
                const picked = pickedStarts.has(start.startsAt);
                const conflict = picked
                  ? null
                  : pickConflict(start, value, dayCap);
                const blocked = (full && !picked) || conflict !== null;
                return (
                  <li key={start.startsAt}>
                    <button
                      type="button"
                      aria-pressed={picked}
                      disabled={blocked}
                      onClick={() => toggle(start)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left text-sm font-medium",
                        picked
                          ? SLOT_STATUS_TOKENS.selected.className
                          : SLOT_STATUS_TOKENS.available.className,
                        blocked && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {start.label}
                      {conflict && !full && (
                        <span className="block text-xs font-normal">
                          {conflict === "overlap"
                            ? "Overlaps a time you picked"
                            : "You already picked a time on this day"}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {days.some((day) => day.starts.length > 0)
                ? "No free times on this day. Pick another day."
                : "No free times in the next two weeks."}
            </p>
          )}

          {full && timesNeeded > 0 && (
            <p className="text-xs text-muted-foreground">
              You&apos;ve picked all {timesWord(timesNeeded)} — tap one to
              change it.
            </p>
          )}
        </>
      )}

      {value.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Your times</h4>
          <ul className="space-y-1.5">
            {value.map((pick) => {
              const taken = justTaken.has(pick.startsAt);
              const label = pickLabel(pick, zone);
              return (
                <li
                  key={pick.startsAt}
                  data-just-taken={taken ? "true" : undefined}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                    taken && JUST_TAKEN.className,
                  )}
                >
                  <span>
                    {label}
                    {taken && (
                      <span className="ml-2 text-xs font-medium no-underline">
                        {JUST_TAKEN.label}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${label}`}
                    onClick={() =>
                      onChange(
                        value.filter((p) => p.startsAt !== pick.startsAt),
                      )
                    }
                    className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
