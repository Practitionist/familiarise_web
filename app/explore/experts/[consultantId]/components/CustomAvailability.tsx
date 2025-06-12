import React from "react";
import { TSlotTiming } from "@/types/slots";
import { DayOfWeek } from "@prisma/client";
import { roundTime, timeToMinutes } from "../utils/time";

interface ProcessedSlot {
  id: string;
  localStartTime: string;
  localEndTime: string;
  originalSlot: any;
  isAllocated?: boolean;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  type?: "WEEKLY" | "CUSTOM";
}

interface DayWithSlots {
  date: Date;
  slots: ProcessedSlot[];
}

interface CustomAvailabilityProps {
  days: DayWithSlots[];
  onSlotSelect: (slot: TSlotTiming) => void;
  selectedSlotId?: string;
}

// Day mapping for TSlotTiming
const dayMap: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

export const CustomAvailability: React.FC<CustomAvailabilityProps> = ({
  days,
  onSlotSelect,
  selectedSlotId,
}) => {
  // Sort slots chronologically for each day
  const sortedDays = React.useMemo(() => {
    return days.map((day) => ({
      ...day,
      slots: day.slots.slice().sort((a, b) => {
        return (
          timeToMinutes(a.localStartTime) - timeToMinutes(b.localStartTime)
        );
      }),
    }));
  }, [days]);

  const handleSlotClick = (slot: ProcessedSlot, date: Date) => {
    // Create a proper TSlotTiming object instead of passing raw slot data
    const slotTiming: TSlotTiming = {
      slotId: slot.id,
      dateInISO: slot.slotStartTimeInUTC || date.toISOString(),
      dayOfWeek: dayMap[date.getDay()],
      slotStartTimeInUTC: slot.slotStartTimeInUTC || date.toISOString(),
      slotEndTimeInUTC: slot.slotEndTimeInUTC || date.toISOString(),
      slotOfAvailabilityId: slot.originalSlot?.id || slot.id,
      slotOfAppointmentId: "",
      localStartTime: slot.localStartTime,
      localEndTime: slot.localEndTime,
      type: slot.type || "CUSTOM",
    };

    onSlotSelect(slotTiming);
  };

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
      <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">
        Custom Availability
      </h3>
      <div className="grid grid-cols-7 gap-6 mb-6">
        {sortedDays.map(({ date }) => (
          <div key={date.toISOString()} className="text-center">
            <div className="text-sm font-semibold text-gray-700">
              {date.toLocaleDateString(undefined, { weekday: "short" })}
            </div>
            <div className="text-xs text-gray-500">
              {date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-6">
        {sortedDays.map(({ date, slots: daySlots }) => (
          <div key={date.toISOString()} className="space-y-3">
            {daySlots.map((slot) => (
              <div
                key={slot.id}
                className={`rounded-md p-2 cursor-pointer transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center ${
                  slot.isAllocated
                    ? "bg-red-50 border border-red-200 cursor-not-allowed"
                    : selectedSlotId === slot.id
                      ? "bg-green-200"
                      : "bg-green-50 hover:bg-green-100"
                }`}
                onClick={() => !slot.isAllocated && handleSlotClick(slot, date)}
              >
                <div
                  className={`text-xs font-medium ${
                    slot.isAllocated ? "text-red-700" : "text-green-700"
                  }`}
                >
                  {roundTime(slot.localStartTime)} -{" "}
                  {roundTime(slot.localEndTime)}
                  {slot.isAllocated && (
                    <div className="text-xs text-red-600 mt-1">
                      Request for approval
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
