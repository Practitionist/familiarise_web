import React from "react";
import { DayOfWeek } from "@prisma/client";
import {
  convertUTCToLocalDate,
  formatTime as formatTimeUtil,
  isSlotRelevantForDay
} from "../utils";

interface WeeklySlot {
  id: string;
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotEndTimeInUTC: string;
}

interface WeeklyAvailabilityProps {
  slots: WeeklySlot[];
  onSlotSelect: (slot: WeeklySlot) => void;
  selectedSlotId?: string;
}

export const WeeklyAvailability: React.FC<WeeklyAvailabilityProps> = ({
  slots,
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

  // Get browser's timezone
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log('Using timezone:', timezone);

  // Group slots by day and sort by time
  const slotsByDay = daysOfWeek.map((day) => {
    // Get slots that are relevant for this day
    const daySlots = slots.filter(slot => isSlotRelevantForDay(slot, day, timezone));

    // Process each slot to handle timezone and overnight slots
    const processedSlots = daySlots.map(slot => {
      // Use a reference date for consistent conversion
      const referenceDate = new Date();
      referenceDate.setHours(0, 0, 0, 0);

      // Convert UTC times to local
      const startDateTime = convertUTCToLocalDate(slot.slotStartTimeInUTC, referenceDate, timezone);
      let endDateTime = convertUTCToLocalDate(slot.slotEndTimeInUTC, referenceDate, timezone);

      // If this slot crosses midnight
      if (slot.dayOfWeekforStartTimeInUTC !== slot.dayOfWeekforEndTimeInUTC ||
          endDateTime <= startDateTime ||
          (endDateTime.getHours() === 0 && endDateTime.getMinutes() === 0)) {
        
        endDateTime = new Date(endDateTime);
        endDateTime.setDate(endDateTime.getDate() + 1);
      }

      return {
        ...slot,
        localStartTime: formatTimeUtil(startDateTime, timezone),
        localEndTime: formatTimeUtil(endDateTime, timezone)
      };
    });

    // Sort slots by start time
    const sortedSlots = processedSlots.sort((a, b) => {
      const timeA = new Date(`1970-01-01 ${a.localStartTime}`).getTime();
      const timeB = new Date(`1970-01-01 ${b.localStartTime}`).getTime();
      return timeA - timeB;
    });

    return {
      day,
      slots: sortedSlots,
    };
  });

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
        {slotsByDay.map(({ day, slots: daySlots }) => (
          <div key={day} className="space-y-3">
            {daySlots.map((slot) => (
              <div
                key={`${slot.id}-${slot.localStartTime}-${slot.localEndTime}`}
                className={`bg-blue-50 rounded-md p-2 cursor-pointer ${
                  selectedSlotId === slot.id
                    ? "bg-blue-200"
                    : "hover:bg-blue-100"
                } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                onClick={() => onSlotSelect(slot)}
              >
                <div className="text-xs font-medium text-blue-700">
                  {slot.localStartTime} - {slot.localEndTime}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
