import { useEffect, useMemo, useState } from "react";
import { DayOfWeek } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { WeeklyAvailability } from "./WeeklyAvailability";
import { CustomAvailability } from "./CustomAvailability";
import {
  normalizeWeeklySlot,
  normalizeCustomSlot,
  formatTime,
  dayMap,
  dayToNumber,
} from "../utils";
import { toZonedTime, fromZonedTime, format as formatTz } from "date-fns-tz";
import { startOfDay, endOfDay, addDays, isBefore } from "date-fns";

interface ConsultantAvailabilityProps {
  consultantDetails: TConsultantProfile;
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
}

type ProcessedSlotsByDay = Record<
  DayOfWeek,
  {
    id: string;
    localStartTime: string;
    localEndTime: string;
    originalSlot: any;
  }[]
>;

export function ConsultantAvailability({
  consultantDetails,
  selectedSlot,
  setSelectedSlot,
  timezone,
}: ConsultantAvailabilityProps) {
  const [processedWeeklySlots, setProcessedWeeklySlots] =
    useState<ProcessedSlotsByDay>({
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
      SATURDAY: [],
      SUNDAY: [],
    });

  useEffect(() => {
    const fetchWeeklyAvailability = async () => {
      if (consultantDetails.scheduleType === "WEEKLY" && timezone) {
        try {
          const response = await fetch(
            `/api/slots/availability/weekly?consultantProfileId=${consultantDetails.id}&timezone=${timezone}`,
          );
          if (!response.ok) {
            throw new Error("Failed to fetch weekly availability");
          }
          const { data } = await response.json();
          setProcessedWeeklySlots(data);
        } catch (error) {
          console.error("Error fetching weekly availability:", error);
        }
      }
    };

    fetchWeeklyAvailability();
  }, [consultantDetails.id, consultantDetails.scheduleType, timezone]);

  const processedCustomSlots = useMemo(() => {
    const today = new Date();
    const rangeStart = startOfDay(toZonedTime(today, timezone));
    const rangeEnd = endOfDay(addDays(rangeStart, 6));

    const days: {
      date: Date;
      slots: {
        id: string;
        localStartTime: string;
        localEndTime: string;
        originalSlot: any;
      }[];
    }[] = Array.from({ length: 7 }, (_, i) => ({
      date: addDays(rangeStart, i),
      slots: [],
    }));

    const slotsByDate: Record<
      string,
      {
        id: string;
        localStartTime: string;
        localEndTime: string;
        originalSlot: any;
      }[]
    > = {};

    consultantDetails.slotsOfAvailabilityCustom.forEach((slot) => {
      const startUTC = new Date(slot.slotStartTimeInUTC);
      const endUTC = new Date(slot.slotEndTimeInUTC);

      if (
        isBefore(endUTC, fromZonedTime(rangeStart, timezone)) ||
        isBefore(fromZonedTime(rangeEnd, timezone), startUTC)
      ) {
        return;
      }

      let current = startUTC;
      while (isBefore(current, endUTC)) {
        const zonedCurrent = toZonedTime(current, timezone);
        const dayStart = startOfDay(zonedCurrent);
        const dateKey = formatTz(dayStart, "yyyy-MM-dd");

        if (isBefore(dayStart, rangeStart) || !isBefore(dayStart, rangeEnd)) {
            current = fromZonedTime(addDays(dayStart, 1), timezone);
            continue;
        }

        const slotPartEnd = isBefore(endUTC, fromZonedTime(endOfDay(zonedCurrent), timezone))
          ? endUTC
          : fromZonedTime(endOfDay(zonedCurrent), timezone);

        if (!slotsByDate[dateKey]) {
          slotsByDate[dateKey] = [];
        }

        slotsByDate[dateKey].push({
          id: `${slot.id}-${current.toISOString()}`,
          localStartTime: formatTz(current, "p", { timeZone: timezone }),
          localEndTime: formatTz(slotPartEnd, "p", { timeZone: timezone }),
          originalSlot: slot,
        });

        current = fromZonedTime(addDays(dayStart, 1), timezone);
      }
    });
    
    days.forEach((day) => {
      const dateKey = formatTz(day.date, "yyyy-MM-dd");
      if (slotsByDate[dateKey]) {
        day.slots = slotsByDate[dateKey].sort((a, b) =>
          a.localStartTime.localeCompare(b.localStartTime, undefined, {
            numeric: true,
          }),
        );
      }
    });

    return days;
  }, [consultantDetails.slotsOfAvailabilityCustom, timezone]);

  return (
    <div>
      <h3 className="text-xl font-semibold mb-4">Consultant Availability</h3>
      <p className="text-sm text-gray-600 mb-4">
        {consultantDetails.scheduleType === "WEEKLY"
          ? "Weekly schedule. Select a time slot to schedule a meeting."
          : "Custom schedule for the next 7 days. Select a time slot to schedule a meeting."}
      </p>

      {consultantDetails.scheduleType === "WEEKLY" ? (
        <WeeklyAvailability
          slotsByDay={processedWeeklySlots}
          onSlotSelect={(slot) => {
            // This logic might need adjustment based on how you want to handle selection
            // For now, let's log it.
            console.log("Selected original slot:", slot);
          }}
          selectedSlotId={selectedSlot?.slotId}
        />
      ) : (
        <CustomAvailability
          days={processedCustomSlots}
          onSlotSelect={(slot) => {
            const normalizedSlot = normalizeCustomSlot(slot);
            setSelectedSlot({
              slotId: normalizedSlot.id,
              dateInISO: new Date(
                normalizedSlot.slotStartTimeInUTC,
              ).toISOString(),
              dayOfWeek:
                dayMap[new Date(normalizedSlot.slotStartTimeInUTC).getDay()],
              slotStartTimeInUTC: normalizedSlot.slotStartTimeInUTC,
              slotEndTimeInUTC: normalizedSlot.slotEndTimeInUTC,
              slotOfAvailabilityId: normalizedSlot.id,
              slotOfAppointmentId: "",
              localStartTime: formatTime(
                normalizedSlot.slotStartTimeInUTC,
                timezone,
              ),
              localEndTime: formatTime(
                normalizedSlot.slotEndTimeInUTC,
                timezone,
              ),
            });
          }}
          selectedSlotId={selectedSlot?.slotId}
        />
      )}
    </div>
  );
}
