"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";

import { useAvailabilityAnswer } from "@/lib/scheduling/use-availability-window";
import type { GridLead } from "@/lib/scheduling/allocationService";
import { quotaFooterText } from "@/lib/scheduling/grid-quota";
import { useNowTick } from "@/hooks/use-now-tick";
import {
  DAY_LIST_DAYS,
  buildDayList,
  dayListAnchor,
  dayListBounds,
  dayListPageStart,
  pickConflict,
  pickLabel,
  stalePicks,
  type DayListPick,
  type DayListRules,
} from "@/lib/scheduling/day-list";
import type { JustTakenReason } from "@/lib/scheduling/week-grid-model";
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
  /** The session the picker opens on, when the surface has one. */
  focusAt?: Date;
  /** The writer the picks go to; its lead time decides which starts are too soon. */
  lead?: GridLead;
  /** The sessions being moved; a new time may overlap their own. */
  movingSessions?: readonly DayListPick[];
  /** Whole-session picks, ISO. */
  value: DayListPick[];
  onChange: (next: DayListPick[]) => void;
  className?: string;
}

const JUST_TAKEN = SLOT_STATUS_TOKENS.justTaken;
const LIMIT_REACHED = SLOT_STATUS_TOKENS.limitReached;
const BEYOND_HORIZON = SLOT_STATUS_TOKENS.beyondHorizon;

function timesWord(count: number): string {
  return `${count} time${count === 1 ? "" : "s"}`;
}

/**
 * The consultee's picker below `md`: a row of day chips over two weeks and
 * the session starts each day offers, read from the same grid endpoint as the
 * desktop heat map. It opens on the latest of today, the allowed window's
 * start and the focused session, and pages two weeks at a time up to the
 * window's end. The host's footer owns "Any time works" and submit; this
 * component only edits `value`, which survives paging.
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
  focusAt,
  lead,
  movingSessions,
  value,
  onChange,
  className,
}: Readonly<MobileDayListPickerProps>) {
  const now = useNowTick(60_000);
  const nowMs = now.getTime();
  const allowedStartMs = allowedStart?.getTime();
  const allowedEndMs = allowedEnd?.getTime();
  const anchorMs = dayListAnchor(
    nowMs,
    allowedStartMs,
    allowedEndMs,
    focusAt?.getTime(),
  );
  // Pages of two weeks from the anchor; never before today or the window's start.
  const [page, setPage] = useState(0);
  const floorStartMs = dayListPageStart(
    Math.max(nowMs, allowedStartMs ?? nowMs),
    zone,
    0,
  );
  const fromMs = Math.max(
    dayListPageStart(anchorMs, zone, page * DAY_LIST_DAYS),
    floorStartMs,
  );
  const nextFromMs = dayListPageStart(fromMs, zone, DAY_LIST_DAYS);
  const canPrev = fromMs > floorStartMs;
  const canNext = allowedEndMs === undefined || nextFromMs < allowedEndMs;
  const bounds = dayListBounds(fromMs, zone);
  const startIso = bounds.start.toISOString();
  const endIso = bounds.end.toISOString();
  const range = useMemo(
    () => ({ start: new Date(startIso), end: new Date(endIso) }),
    [startIso, endIso],
  );
  const query = useAvailabilityAnswer({
    consultantId,
    startUtc: range.start,
    endUtc: range.end,
    timezone: zone,
    consulteeUserId,
    subscriptionId,
    releasingIds,
    lead,
    // Midnight moves the window; keep the list instead of a skeleton.
    keepPrevious: true,
  });
  const cells = query.data?.data;
  const quota = query.data?.quota ?? null;
  const leadMs = query.data?.leadMs ?? null;

  const rules = useMemo<DayListRules>(
    () => ({
      zone,
      sessionMinutes,
      nowMs,
      allowedStart:
        allowedStartMs === undefined ? undefined : new Date(allowedStartMs),
      allowedEnd:
        allowedEndMs === undefined ? undefined : new Date(allowedEndMs),
      leadMs,
      movingSessions,
    }),
    [
      zone,
      sessionMinutes,
      nowMs,
      allowedStartMs,
      allowedEndMs,
      leadMs,
      movingSessions,
    ],
  );
  const days = useMemo(
    () => (cells ? buildDayList(cells, rules, fromMs) : []),
    [cells, rules, fromMs],
  );

  // A pick the latest answer no longer allows is dropped and announced; one
  // someone else took paints "Just taken" for the render before it goes.
  const [announcement, setAnnouncement] = useState("");
  const stale = useMemo(
    () =>
      cells
        ? stalePicks(value, cells, rules, fromMs)
        : new Map<string, JustTakenReason>(),
    [cells, value, rules, fromMs],
  );
  const dropStale = useCallback(
    (keys: string[]) => {
      const gone = value.filter((pick) => keys.includes(pick.startsAt));
      if (gone.length === 0) return;
      onChange(value.filter((pick) => !keys.includes(pick.startsAt)));
      const taken = gone.some((pick) => stale.get(pick.startsAt) === "taken");
      const one = gone.length === 1 ? pickLabel(gone[0], zone) : null;
      if (taken) {
        setAnnouncement(
          one
            ? `${one} is no longer free, so we removed it. Pick another time.`
            : `${gone.length} of your times are no longer free, so we removed them. Pick other times.`,
        );
      } else {
        setAnnouncement(
          one
            ? `${one} can't be booked any more: it is now too close to its start or past this plan's limit. We removed it — pick another time.`
            : `${gone.length} of your times can't be booked any more: they are now too close to their start or past this plan's limit. We removed them — pick other times.`,
        );
      }
    },
    [value, onChange, zone, stale],
  );
  const staleKeys = useMemo(() => [...stale.keys()], [stale]);
  const justTaken = useJustTaken(staleKeys, dropStale);

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
  const firstLoad = cells === undefined;
  const quotaLine = quota ? quotaFooterText(quota, zone, nowMs) : null;
  // The plan's limit, not the expert's calendar, is why nothing is offered.
  const limitIsWhy =
    activeDay?.limitReached === true ||
    (days.every((day) => day.starts.length === 0) &&
      days.some((day) => day.limitReached));
  const horizonIsWhy =
    activeDay?.beyondHorizon === true ||
    (days.every((day) => day.starts.length === 0) &&
      days.some((day) => day.beyondHorizon));

  // Its own scroll area: the host's fixed-height column puts the footer below it.
  return (
    <div
      className={cn("min-h-0 space-y-4 overflow-y-auto", className)}
      data-testid="mobile-day-list"
    >
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
          <div className="flex items-center justify-between gap-2 text-sm">
            <button
              type="button"
              disabled={!canPrev}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-md border px-2.5 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous 2 weeks
            </button>
            <span className="text-muted-foreground">
              {days.length > 0
                ? `${days[0].label} – ${days[days.length - 1].label}`
                : null}
            </span>
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md border px-2.5 py-1.5 font-medium disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next 2 weeks
            </button>
          </div>

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
          ) : limitIsWhy ? (
            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                {LIMIT_REACHED.label}
              </p>
              <p>
                {quotaLine
                  ? `${quotaLine}. Pick a day or week that still has room.`
                  : LIMIT_REACHED.hint}
              </p>
            </div>
          ) : horizonIsWhy ? (
            <p className="text-sm text-muted-foreground">
              {BEYOND_HORIZON.hint}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {days.some((day) => day.starts.length > 0)
                ? "No free times on this day. Pick another day."
                : canNext
                  ? "No free times in these two weeks. Try the next two weeks."
                  : "No free times in these two weeks."}
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
              const taken =
                justTaken.has(pick.startsAt) &&
                stale.get(pick.startsAt) === "taken";
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
