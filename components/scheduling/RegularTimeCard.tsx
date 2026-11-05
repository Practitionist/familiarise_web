"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { MobileAutoSchedule } from "@/components/scheduling/MobileAutoSchedule";
import {
  WEEKDAY_SHORT,
  formatLocalMinutes,
  regularSlotsRefusal,
  type RegularSlot,
} from "@/lib/booking/regular-time/project";
import {
  CONFLICT_COPY,
  type ConflictReason,
} from "@/lib/booking/regular-time/conflicts";
import { formatDateRangeLabel } from "@/lib/time/display";

interface ViewWeek {
  weekIndex: number;
  startsAt: string;
  endsAt: string;
  capacity: number;
  held: number;
  shortBy: number;
  conflicts: { reason: ConflictReason; startsAt: string }[];
}

export interface RegularTimeViewDto {
  perWeek: number;
  slots: RegularSlot[];
  label: string | null;
  timeZone: string;
  weekCount: number;
  weeks: ViewWeek[];
  paused: boolean;
}

/** Local start times every 15 minutes, so a :45 zone can still land on the grid. */
const TIMES = Array.from({ length: 96 }, (_, i) => i * 15);
const EIGHT_WEEKS_MS = 8 * 7 * 24 * 3_600_000;

/** "2 to fix" across the horizon, less what the consultant chose to skip. */
export function toFixCount(
  weeks: readonly ViewWeek[],
  skipped: ReadonlySet<string>,
) {
  return weeks.reduce(
    (n, w) => n + w.conflicts.filter((c) => !skipped.has(c.startsAt)).length,
    0,
  );
}

/**
 * The Regular-time card on the allocate page, mobile-first: day chips and one
 * time in the plan's zone, live hints, and the next four weeks with what each
 * still needs. Pick another time opens the grid on that week; Auto fills it;
 * Skip only hides the row (the week catches up later).
 */
export function RegularTimeCard({
  subscriptionId,
  onPickWeek,
  onChanged,
}: Readonly<{
  subscriptionId: string;
  onPickWeek: (weekStartsAt: Date) => void;
  onChanged: () => void;
}>) {
  const [view, setView] = useState<RegularTimeViewDto | null>(null);
  const [days, setDays] = useState<number[]>([]);
  const [minutes, setMinutes] = useState(18 * 60);
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const url = `/api/appointments/${encodeURIComponent(subscriptionId)}/regular-time`;

  const load = useCallback(async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as RegularTimeViewDto;
    setView(next);
    if (next.slots.length > 0) {
      setDays(next.slots.map((s) => s.weekday).sort((a, b) => a - b));
      setMinutes(next.slots[0].localStartMinutes);
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const slots = useMemo(
    () => days.map((weekday) => ({ weekday, localStartMinutes: minutes })),
    [days, minutes],
  );
  const hint = useMemo(() => {
    if (!view) return null;
    const now = new Date();
    return regularSlotsRefusal(slots, {
      perWeek: view.perWeek,
      timeZone: view.timeZone,
      planStartsAt: now,
      planEndsAt: new Date(now.getTime() + EIGHT_WEEKS_MS),
      fromWeek: 0,
      weeks: 8,
    });
  }, [slots, view]);

  if (!view) return null;

  const toggle = (weekday: number) =>
    setDays((current) =>
      current.includes(weekday)
        ? current.filter((d) => d !== weekday)
        : [...current, weekday].sort((a, b) => a - b),
    );

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      toast({
        title: response.ok ? "Regular time saved" : "Couldn't save",
        description: response.ok ? body.message : body.error,
        variant: response.ok ? "default" : "destructive",
      });
      if (response.ok) {
        await load();
        onChanged();
      }
    } finally {
      setSaving(false);
    }
  };

  const toFix = toFixCount(view.weeks, skipped);

  return (
    <section
      aria-label="Regular time"
      className="space-y-3 rounded-lg border p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Regular time</h2>
        {toFix > 0 && <Badge variant="destructive">{toFix} to fix</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        Pick {view.perWeek} {view.perWeek === 1 ? "day" : "days"} and a time.
        Times shown in {view.timeZone}.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
        {WEEKDAY_SHORT.map((label, i) => {
          const weekday = i + 1;
          const on = days.includes(weekday);
          return (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              aria-pressed={on}
              onClick={() => toggle(weekday)}
            >
              {label}
            </Button>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <span>Time</span>
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          {TIMES.map((m) => (
            <option key={m} value={m}>
              {formatLocalMinutes(m)}
            </option>
          ))}
        </select>
      </label>
      {hint && days.length > 0 && (
        <p role="status" className="text-sm text-destructive">
          {hint.message}
        </p>
      )}
      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={saving || hint !== null}
        onClick={save}
      >
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Save regular time
      </Button>
      {view.paused && (
        <p className="text-sm text-muted-foreground">
          Booking ahead is paused. Save the regular time again to restart it.
        </p>
      )}
      {view.weeks.length > 0 && (
        <ul className="space-y-2" aria-label="Next four weeks">
          {view.weeks.map((week) => {
            const conflicts = week.conflicts.filter(
              (c) => !skipped.has(c.startsAt),
            );
            return (
              <li key={week.weekIndex} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center justify-between gap-1 text-sm">
                  <span className="font-medium">
                    Week {week.weekIndex + 1} of {view.weekCount}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDateRangeLabel(
                      new Date(week.startsAt),
                      new Date(new Date(week.endsAt).getTime() - 1),
                      { zone: view.timeZone },
                    )}{" "}
                    · {week.held} of {week.capacity} booked
                  </span>
                </div>
                {conflicts.map((c) => (
                  <div
                    key={c.startsAt}
                    className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm">
                      {formatInTimeZone(
                        new Date(c.startsAt),
                        view.timeZone,
                        "EEE d MMM, HH:mm",
                      )}
                      : {CONFLICT_COPY[c.reason]}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onPickWeek(new Date(week.startsAt))}
                      >
                        Pick another time
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSkipped((s) => new Set(s).add(c.startsAt))
                        }
                      >
                        Skip, catch up later
                      </Button>
                    </div>
                  </div>
                ))}
                {conflicts.length > 0 && week.shortBy > 0 && (
                  <div className="mt-2">
                    <MobileAutoSchedule
                      eventType="subscription"
                      eventId={subscriptionId}
                      topUp
                      onDone={() => {
                        void load();
                        onChanged();
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
