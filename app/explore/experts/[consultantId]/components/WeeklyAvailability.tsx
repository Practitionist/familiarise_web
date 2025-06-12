import React from "react";
import { DayOfWeek } from "@prisma/client";
import { TSlotTiming } from "@/types/slots";
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

interface WeeklyAvailabilityProps {
  slotsByDay: Record<DayOfWeek, ProcessedSlot[]>;
  onSlotSelect: (slot: TSlotTiming) => void;
  selectedSlotId?: string;
}

export const WeeklyAvailability: React.FC<WeeklyAvailabilityProps> = ({
  slotsByDay,
  onSlotSelect,
  selectedSlotId,
}) => {
  const daysOfWeek = [
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY,
    DayOfWeek.SUNDAY,
  ];
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Sort slots chronologically for each day
  const sortedSlotsByDay = React.useMemo(() => {
    const sorted: Record<DayOfWeek, ProcessedSlot[]> = {} as Record<
      DayOfWeek,
      ProcessedSlot[]
    >;

    daysOfWeek.forEach((day) => {
      sorted[day] = (slotsByDay[day] || []).slice().sort((a, b) => {
        return (
          timeToMinutes(a.localStartTime) - timeToMinutes(b.localStartTime)
        );
      });
    });

    return sorted;
  }, [slotsByDay]);

  const handleSlotClick = (slot: ProcessedSlot, dayOfWeek: DayOfWeek) => {
    // Create a proper TSlotTiming object instead of passing raw slot data
    const slotTiming: TSlotTiming = {
      slotId: slot.id,
      dateInISO: slot.slotStartTimeInUTC || new Date().toISOString(),
      dayOfWeek: dayOfWeek,
      slotStartTimeInUTC: slot.slotStartTimeInUTC || new Date().toISOString(),
      slotEndTimeInUTC: slot.slotEndTimeInUTC || new Date().toISOString(),
      slotOfAvailabilityId: slot.originalSlot?.id || slot.id,
      slotOfAppointmentId: "",
      localStartTime: slot.localStartTime,
      localEndTime: slot.localEndTime,
      type: slot.type || "WEEKLY",
    };

    onSlotSelect(slotTiming);
  };

  return (
    <div className="bg-white rounded-lg shadow-lg p-8 border border-gray-200">
      <h3 className="text-2xl font-semibold mb-6 text-center text-gray-800">
        Weekly Availability
      </h3>
      <div className="grid grid-cols-7 gap-6 mb-6">
        {dayLabels.map((day) => (
          <div
            key={day}
            className="text-center text-sm font-semibold text-gray-700"
          >
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-6">
        {daysOfWeek.map((day) => (
          <div key={day} className="space-y-3">
            {sortedSlotsByDay[day]?.map((slot) => (
              <div
                key={`${slot.id}-${slot.localStartTime}`}
                className={`rounded-md p-2 cursor-pointer transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center ${
                  slot.isAllocated
                    ? "bg-red-50 border border-red-200 cursor-not-allowed"
                    : selectedSlotId === slot.id
                      ? "bg-blue-200"
                      : "bg-blue-50 hover:bg-blue-100"
                }`}
                onClick={() => !slot.isAllocated && handleSlotClick(slot, day)}
              >
                <div
                  className={`text-xs font-medium ${
                    slot.isAllocated ? "text-red-700" : "text-blue-700"
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
