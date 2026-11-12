"use client";

import { useMemo, useState } from "react";
import { addDays } from "date-fns";

import { useNowTick } from "@/hooks/use-now-tick";
import {
  isBookableWindow,
  windowsForDay,
  type SlotWithStatus,
} from "@/lib/scheduling/booking-windows";
import {
  AVAILABILITY_READ_FAILED_MESSAGE,
  useAvailabilityWindow,
} from "@/lib/scheduling/use-availability-window";
import {
  calendarDateKey,
  calendarDayOf,
  dayRangeBounds,
} from "@/lib/time/grid-zone";
import { cn } from "@/utils/tailwind";
import { SlotList } from "./SlotList";

/** How many days ahead the trial picker offers; one grid read covers them all. */
export const TRIAL_PICKER_DAYS = 14;

interface TrialSlotPickerProps {
  consultantId: string;
  /** The buyer, so their own busy times are taken out too. */
  consulteeUserId?: string;
  trialDurationMinutes: number;
  /** The writer's lead time (`leadMsFor`), so no listed time is refused as too soon. */
  leadMs: number;
  /** The zone every day and time is drawn in. */
  timezone: string;
  selected: SlotWithStatus | null;
  onSelect: (slot: SlotWithStatus | null) => void;
}

/**
 * The buyer's trial picker: a strip of the next two weeks and, for the chosen
 * day, the expert page's own `SlotList` of bookable windows of the trial's
 * length, cut by `windowsForDay` with the same lead time the server applies.
 */
export function TrialSlotPicker({
  consultantId,
  consulteeUserId,
  trialDurationMinutes,
  leadMs,
  timezone,
  selected,
  onSelect,
}: Readonly<TrialSlotPickerProps>) {
  const now = useNowTick(60_000);
  // Keyed on the calendar date, so the strip changes only when the day does.
  const todayKey = calendarDateKey(calendarDayOf(now, timezone));
  const days = useMemo(() => {
    const [year, month, day] = todayKey.split("-").map(Number);
    const first = new Date(year, month - 1, day, 12);
    return Array.from({ length: TRIAL_PICKER_DAYS }, (_, i) =>
      addDays(first, i),
    );
  }, [todayKey]);
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const bounds = dayRangeBounds(days[0], days[days.length - 1], timezone);
  const query = useAvailabilityWindow({
    consultantId,
    startUtc: bounds.start,
    endUtc: bounds.end,
    timezone,
    consulteeUserId,
    keepPrevious: true,
  });

  const windowsByDay = useMemo(() => {
    const out = new Map<string, SlotWithStatus[]>();
    for (const day of days) {
      const key = calendarDateKey(day);
      out.set(
        key,
        windowsForDay(
          query.data?.[key] ?? [],
          trialDurationMinutes / 60,
          timezone,
          now.getTime(),
          leadMs,
        ),
      );
    }
    return out;
  }, [days, query.data, trialDurationMinutes, timezone, now, leadMs]);

  const firstOpenKey =
    days
      .map((day) => calendarDateKey(day))
      .find((key) => (windowsByDay.get(key) ?? []).some(isBookableWindow)) ??
    calendarDateKey(days[0]);
  const activeKey = pickedKey ?? firstOpenKey;
  const activeWindows = windowsByDay.get(activeKey) ?? [];

  return (
    <div className="min-w-0 space-y-3 rounded-xl bg-zinc-900 p-3 text-zinc-100">
      <div
        className="flex min-w-0 gap-2 overflow-x-auto pb-1"
        role="group"
        aria-label="Pick a day"
      >
        {days.map((day) => {
          const key = calendarDateKey(day);
          const open = (windowsByDay.get(key) ?? []).some(isBookableWindow);
          const active = key === activeKey;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              disabled={!open || query.isPending}
              onClick={() => {
                setPickedKey(key);
                onSelect(null);
              }}
              className={cn(
                "flex min-w-[3.5rem] flex-col items-center rounded-lg border px-2 py-1.5 text-xs transition-colors",
                active
                  ? "border-white bg-white text-zinc-900"
                  : open
                    ? "border-white/30 text-zinc-100 hover:bg-white/10"
                    : "border-white/10 text-zinc-500",
              )}
            >
              <span>
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span className="text-sm font-semibold">{day.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {query.isPending ? (
          <p className="py-4 text-center text-sm text-zinc-400">
            Loading times…
          </p>
        ) : query.isError && !query.data ? (
          <p role="alert" className="py-4 text-center text-sm text-zinc-400">
            {AVAILABILITY_READ_FAILED_MESSAGE}
          </p>
        ) : (
          <SlotList
            slots={activeWindows}
            selectedSlot={selected}
            onSelect={onSelect}
            bookingMode="INSTANT"
          />
        )}
      </div>
    </div>
  );
}
