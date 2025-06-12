import { useEffect, useMemo, useState } from "react";
import { DayOfWeek } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { TSlotTiming } from "@/types/slots";
import { WeeklyAvailability } from "./WeeklyAvailability";
import { CustomAvailability } from "./CustomAvailability";
import { addDays, startOfDay, endOfDay } from "date-fns";
import { toZonedTime, format as formatTz } from "date-fns-tz";

interface ConsultantAvailabilityProps {
  consultantDetails: TConsultantProfile;
  selectedSlot: TSlotTiming | null;
  setSelectedSlot: (slot: TSlotTiming | null) => void;
  timezone: string;
}

// Better typing for slot types
type WeeklySlotData = {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
};

type CustomSlotData = {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
};

interface ProcessedSlot {
    id: string;
    localStartTime: string;
    localEndTime: string;
  originalSlot: WeeklySlotData | CustomSlotData;
  isAllocated?: boolean;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  type?: "WEEKLY" | "CUSTOM";
}

type ProcessedSlotsByDay = Record<DayOfWeek, ProcessedSlot[]>;

type DayWithSlots = {
  date: Date;
  slots: ProcessedSlot[];
};

export function ConsultantAvailability({
  consultantDetails,
  selectedSlot,
  setSelectedSlot,
  timezone,
}: ConsultantAvailabilityProps) {
  const [availabilityData, setAvailabilityData] = useState<
    Record<string, (TSlotTiming & { isAllocated: boolean; bookingStatus: 'available' | 'partially-booked' | 'fully-booked' })[]>
  >({});
  const [isLoading, setIsLoading] = useState(false);

  // Fetch unified availability data with allocation status
  useEffect(() => {
    const fetchAvailabilityData = async () => {
      if (!consultantDetails?.id || !timezone) return;

      setIsLoading(true);
      try {
        // Fetch slots for the next 7 days to cover both weekly and custom availability
        const today = new Date();
        const startDateInUtc = startOfDay(today);
        const endDateInUtc = endOfDay(addDays(today, 6));

        const response = await fetch(
          `/api/slots/availability-with-allocation/${consultantDetails.id}?startDateInUtc=${startDateInUtc.toISOString()}&endDateInUtc=${endDateInUtc.toISOString()}&timezone=${timezone}`,
        );

        if (!response.ok) {
          throw new Error("Failed to fetch availability data");
        }

        const { data } = await response.json();
        setAvailabilityData(data);
      } catch (error) {
        console.error("Error fetching availability data:", error);
        setAvailabilityData({});
      } finally {
        setIsLoading(false);
      }
    };

    fetchAvailabilityData();
  }, [consultantDetails?.id, timezone]);

  // Process data for WeeklyAvailability component (group by day of week)
  const processedWeeklySlots = useMemo((): ProcessedSlotsByDay => {
    const slotsByDay: ProcessedSlotsByDay = {
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
      SATURDAY: [],
      SUNDAY: [],
    };

    if (consultantDetails.scheduleType === "WEEKLY") {
      Object.entries(availabilityData).forEach(([dateStr, slots]) => {
        slots
          .filter((slot) => slot.type === "WEEKLY")
          .forEach((slot) => {
            slotsByDay[slot.dayOfWeek].push({
              id: slot.slotId,
              localStartTime: slot.localStartTime,
              localEndTime: slot.localEndTime,
              originalSlot: {
                id: slot.slotOfAvailabilityId,
                slotStartTimeInUTC: slot.slotStartTimeInUTC,
                slotEndTimeInUTC: slot.slotEndTimeInUTC,
              },
              isAllocated: slot.isAllocated,
              bookingStatus: slot.bookingStatus || 'available',
              slotStartTimeInUTC: slot.slotStartTimeInUTC,
              slotEndTimeInUTC: slot.slotEndTimeInUTC,
              type: "WEEKLY",
            } as ProcessedSlot);
          });
      });
    }

    return slotsByDay;
  }, [availabilityData, consultantDetails.scheduleType]);

  // Process data for CustomAvailability component (group by date)
  // Note: Allow custom slots for all schedule types to support one-off availability
  const processedCustomSlots = useMemo((): DayWithSlots[] => {
    const today = new Date();
    const days: DayWithSlots[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(startOfDay(toZonedTime(today, timezone)), i);
      const dateKey = formatTz(date, "yyyy-MM-dd", { timeZone: timezone });

      const slots: ProcessedSlot[] = (availabilityData[dateKey] || [])
        .filter((slot) => slot.type === "CUSTOM")
        .map((slot) => ({
          id: slot.slotId,
          localStartTime: slot.localStartTime,
          localEndTime: slot.localEndTime,
          originalSlot: {
            id: slot.slotOfAvailabilityId,
            slotStartTimeInUTC: slot.slotStartTimeInUTC,
            slotEndTimeInUTC: slot.slotEndTimeInUTC,
          },
          isAllocated: slot.isAllocated,
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
          type: "CUSTOM",
        }));

      return { date, slots };
    });

    return days;
  }, [availabilityData, timezone]);

  const handleSlotSelect = (slot: TSlotTiming) => {
    setSelectedSlot(slot);
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
        <h3 className="text-xl font-semibold mb-4">Consultant Availability</h3>
        <div className="flex items-center justify-center py-8">
          <div className="text-gray-500">Loading availability...</div>
        </div>
      </div>
    );
  }

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
          onSlotSelect={handleSlotSelect}
          selectedSlotId={selectedSlot?.slotId}
        />
      ) : (
        <CustomAvailability
          days={processedCustomSlots}
          onSlotSelect={handleSlotSelect}
          selectedSlotId={selectedSlot?.slotId}
        />
      )}
    </div>
  );
}
