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
      <div className="bg-gradient-to-br from-white via-gray-50/50 to-white rounded-2xl shadow-xl border border-gray-200/50 p-8 backdrop-blur-sm relative">
        <div className="relative text-center">
          <h3 className="text-xl font-bold mb-2 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
            Consultant Availability
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            Couldn&apos;t load availability. Please try again.
          </p>
          <button
            type="button"
            onClick={() => weekQuery.refetch()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showLoadingCard) {
    return (
      <div className="bg-gradient-to-br from-white via-gray-50/50 to-white rounded-2xl shadow-xl border border-gray-200/50 p-8 backdrop-blur-sm relative">
        <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-2xl pointer-events-none" />
        <div className="relative">
          <h3 className="text-xl font-bold mb-4 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
            Consultant Availability
          </h3>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground flex items-center space-x-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-muted-foreground"></div>
              <span>Loading availability...</span>
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
        <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
          Consultant Availability
        </h3>
        <p className="text-sm text-muted-foreground bg-gradient-to-br from-gray-50 to-white px-4 py-2 rounded-xl border border-border shadow-sm inline-block">
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
