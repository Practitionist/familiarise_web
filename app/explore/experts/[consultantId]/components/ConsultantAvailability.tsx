import { useCallback, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import { DayOfWeek } from "@prisma/client";
import { WeeklyAvailability } from "./WeeklyAvailability";
import { CustomAvailability } from "./CustomAvailability";
import { SlotStatusLegend } from "@/components/scheduling/SlotStatusLegend";
import { BUYER_LEGEND_KEYS } from "@/lib/scheduling/interval-status-tokens";
import { addDays, startOfDay, endOfDay } from "date-fns";
import { toZonedTime, formatInTimeZone } from "date-fns-tz";
import type { ConsultantDetailData, PickerInterval } from "../types";
import { useAvailabilityWindow } from "../hooks/useAvailabilityWindow";

interface ConsultantAvailabilityProps {
  consultantDetails: ConsultantDetailData;
  timezone: string;
  /**
   * Shared with the pricing panel's reader: both observers carry the same
   * one-shot bypass ref, so a BFCache-restore invalidation refetches past
   * the browser cache no matter which observer's queryFn the shared entry
   * keeps. Consumed once, by whichever fetch runs first.
   */
  bypassRef?: MutableRefObject<boolean>;
}

type PickerIntervalsByDay = Record<DayOfWeek, PickerInterval[]>;

type DayWithSlots = {
  date: Date;
  slots: PickerInterval[];
};

export function ConsultantAvailability({
  consultantDetails,
  timezone,
  bypassRef,
}: ConsultantAvailabilityProps) {
  const [weekOffset, setWeekOffset] = useState(0);

  const handlePrevWeek = useCallback(() => {
    setWeekOffset((w) => Math.max(0, w - 1));
  }, []);

  const handleNextWeek = useCallback(() => {
    setWeekOffset((w) => w + 1);
  }, []);

  // Shared week-window query (see useAvailabilityWindow): the pricing panel
  // reads the same (consultant, window, timezone) key, so the mount-time
  // overview fetch and the pricing day fetch collapse into ONE allocation
  // compute instead of two overlapping ones.
  const today = new Date();
  const windowStart = addDays(today, weekOffset * 7);
  const startDateInUtc = startOfDay(windowStart);
  const endDateInUtc = endOfDay(addDays(windowStart, 6));

  const weekQuery = useAvailabilityWindow({
    consultantId: consultantDetails?.id,
    startUtc: consultantDetails?.id ? startDateInUtc : null,
    endUtc: consultantDetails?.id ? endDateInUtc : null,
    timezone: consultantDetails?.id ? timezone : null,
    bypassRef,
  });

  // Keep the previous week's rows on screen while the next week loads (was:
  // full loading card on every arrow click). First paint still shows the
  // loading card until the first window lands. Memoized: the downstream
  // useMemos diff this reference, and `?? {}` would mint a new object per
  // render and defeat them.
  const availabilityData = useMemo(
    () => weekQuery.data ?? {},
    [weekQuery.data],
  );
  const hasData = Object.keys(availabilityData).length > 0;
  const showLoadingCard = weekQuery.isLoading && !hasData;
  // A failed week fetch must not read as "no availability" (flag consumed
  // below, after ALL hooks — early returns cannot precede useMemo calls).
  const showErrorCard = !!weekQuery.error && !hasData;

  // Process data for WeeklyAvailability component (group by day of week)
  const processedWeeklySlots = useMemo((): PickerIntervalsByDay => {
    const slotsByDay: PickerIntervalsByDay = {
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
      SATURDAY: [],
      SUNDAY: [],
    };

    if (consultantDetails.scheduleType === "WEEKLY") {
      Object.entries(availabilityData).forEach(([_dateStr, slots]) => {
        slots
          .filter((slot) => slot.type === "WEEKLY")
          .forEach((slot) => {
            slotsByDay[slot.dayOfWeek].push({
              id: slot.slotId,
              localStartTime: slot.localStartTime,
              localEndTime: slot.localEndTime,
              originalSlot: {
                id: slot.availabilityWindowId,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
              },
              isAllocated: slot.isAllocated,
              bookingStatus: slot.bookingStatus || "available",
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              type: "WEEKLY",
            } as PickerInterval);
          });
      });
    }

    return slotsByDay;
  }, [availabilityData, consultantDetails.scheduleType]);

  // Process data for CustomAvailability component (group by date)
  // Note: Allow custom slots for all schedule types to support one-off availability
  const processedCustomSlots = useMemo((): DayWithSlots[] => {
    const today = new Date();
    const windowStart = addDays(today, weekOffset * 7);
    const days: DayWithSlots[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(startOfDay(toZonedTime(windowStart, timezone)), i);
      const dateKey = formatInTimeZone(date, timezone, "yyyy-MM-dd");

      const slots: PickerInterval[] = (availabilityData[dateKey] || [])
        .filter((slot) => slot.type === "CUSTOM")
        .map((slot) => ({
          id: slot.slotId,
          localStartTime: slot.localStartTime,
          localEndTime: slot.localEndTime,
          originalSlot: {
            id: slot.availabilityWindowId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          },
          isAllocated: slot.isAllocated,
          bookingStatus: slot.bookingStatus || "available",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          type: "CUSTOM",
        }));

      return { date, slots };
    });

    return days;
  }, [availabilityData, timezone, weekOffset]);

  if (showErrorCard) {
    return (
      <div className="relative rounded-card border border-border bg-card p-8 shadow-elevation-1 shadow-edge">
        <div className="relative text-center">
          <h3 className="mb-2 font-display text-lg font-semibold tracking-tight text-foreground">
            Consultant Availability
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Couldn&apos;t load availability. Please try again.
          </p>
          <button
            type="button"
            onClick={() => weekQuery.refetch()}
            className="rounded-control bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showLoadingCard) {
    return (
      <div className="relative rounded-card border border-border bg-card p-8 shadow-elevation-1 shadow-edge">
        <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-card pointer-events-none" />
        <div className="relative">
          <h3 className="mb-4 font-display text-lg font-semibold tracking-tight text-foreground">
            Consultant Availability
          </h3>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground flex items-center space-x-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-b-brand motion-reduce:animate-none"></div>
              <span className="text-sm">Loading availability…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Background week change: keep stale rows visible, dimmed, instead of
  // flashing the loading card (see showLoadingCard above for first paint).
  const refetching = weekQuery.isFetching && hasData;

  return (
    <div
      className={
        refetching ? "space-y-6 opacity-70 transition-opacity" : "space-y-6"
      }
    >
      <div className="text-center">
        <h3 className="mb-3 font-display text-lg font-semibold tracking-tight text-foreground">
          Consultant Availability
        </h3>
        <p className="inline-block max-w-2xl rounded-control border border-border bg-surface px-4 py-2 text-sm text-muted-foreground">
          {consultantDetails.scheduleType === "WEEKLY"
            ? "Weekly schedule. Use the 'Book Now' button to schedule a meeting."
            : "Custom schedule. Use the arrows to navigate weeks. Use the 'Book Now' button to schedule a meeting."}
        </p>
      </div>

      {consultantDetails.scheduleType === "WEEKLY" ? (
        <WeeklyAvailability slotsByDay={processedWeeklySlots} />
      ) : (
        <CustomAvailability
          days={processedCustomSlots}
          onPrevWeek={weekOffset > 0 ? handlePrevWeek : undefined}
          onNextWeek={handleNextWeek}
        />
      )}

      {/* This grid is a read-only overview — booking happens in the pricing
          panel — so the colours need explaining even more than the interactive
          ones do. */}
      <SlotStatusLegend keys={BUYER_LEGEND_KEYS} className="mt-4" />
    </div>
  );
}
