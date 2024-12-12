import React from "react";
import { DayOfWeek } from "@prisma/client";

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

function convertUTCToLocal(date: Date): Date {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - (offset * 60 * 1000));
}

function getDayBefore(day: DayOfWeek): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY
  ];
  const index = days.indexOf(day);
  return days[(index - 1 + 7) % 7];
}

function getDayAfter(day: DayOfWeek): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY
  ];
  const index = days.indexOf(day);
  return days[(index + 1) % 7];
}

const formatTime = (isoString: string): string => {
  try {
    // Create a base date for today
    const baseDate = new Date();
    // Parse the time from the ISO string
    const utcDate = new Date(isoString);
    // Set the hours and minutes on the base date
    baseDate.setHours(utcDate.getUTCHours(), utcDate.getUTCMinutes(), 0, 0);
    // Convert to local time
    const localDate = convertUTCToLocal(baseDate);
    
    return localDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch (error) {
    console.error("Error formatting time:", error);
    return "Invalid Time";
  }
};

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

  // Group slots by day and sort by time
  const slotsByDay = daysOfWeek.map((day) => {
    // Get slots that:
    // 1. Start on this day
    // 2. End on this day (started previous day)
    // 3. Start on this day and end next day
    const daySlots = slots.filter((slot) => {
      const previousDay = getDayBefore(day);
      const nextDay = getDayAfter(day);

      // Include slots that:
      // 1. Start on this day
      // 2. End on this day (started previous day)
      // 3. Start on this day and end next day
      // 4. Start on previous day and end on next day (crosses entire day)
      return (
        slot.dayOfWeekforStartTimeInUTC === day ||
        slot.dayOfWeekforEndTimeInUTC === day ||
        (slot.dayOfWeekforStartTimeInUTC === previousDay && 
         slot.dayOfWeekforEndTimeInUTC === nextDay)
      );
    });

    // For each slot, determine if it needs to be split at midnight
    const processedSlots = daySlots.flatMap((slot) => {
      // Create a base date for today
      const baseDate = new Date();
      // Parse the times from the ISO strings
      const startTime = new Date(slot.slotStartTimeInUTC);
      const endTime = new Date(slot.slotEndTimeInUTC);
      
      // Set the hours and minutes on the base date
      const localStartTime = new Date(baseDate);
      localStartTime.setHours(startTime.getUTCHours(), startTime.getUTCMinutes(), 0, 0);
      
      const localEndTime = new Date(baseDate);
      localEndTime.setHours(endTime.getUTCHours(), endTime.getUTCMinutes(), 0, 0);

      // Convert to local time
      const convertedStartTime = convertUTCToLocal(localStartTime);
      const convertedEndTime = convertUTCToLocal(localEndTime);

      // If the slot crosses midnight
      if (convertedEndTime < convertedStartTime) {
        // Create two slots: one ending at midnight, one starting at midnight
        const midnightEnd = new Date(convertedStartTime);
        midnightEnd.setHours(23, 59, 59, 999);

        const midnightStart = new Date(convertedEndTime);
        midnightStart.setHours(0, 0, 0, 0);

        return [
          {
            ...slot,
            slotStartTimeInUTC: convertedStartTime.toISOString(),
            slotEndTimeInUTC: midnightEnd.toISOString(),
          },
          {
            ...slot,
            slotStartTimeInUTC: midnightStart.toISOString(),
            slotEndTimeInUTC: convertedEndTime.toISOString(),
          },
        ];
      }

      return [{
        ...slot,
        slotStartTimeInUTC: convertedStartTime.toISOString(),
        slotEndTimeInUTC: convertedEndTime.toISOString(),
      }];
    });

    // Sort slots by start time
    const sortedSlots = processedSlots.sort((a, b) => {
      const timeA = new Date(a.slotStartTimeInUTC).getTime();
      const timeB = new Date(b.slotStartTimeInUTC).getTime();
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
            {daySlots.map((slot) => {
              const startTime = formatTime(slot.slotStartTimeInUTC);
              const endTime = formatTime(slot.slotEndTimeInUTC);

              return (
                <div
                  key={`${slot.id}-${startTime}-${endTime}`}
                  className={`bg-blue-50 rounded-md p-2 cursor-pointer ${
                    selectedSlotId === slot.id
                      ? "bg-blue-200"
                      : "hover:bg-blue-100"
                  } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                  onClick={() => onSlotSelect(slot)}
                >
                  <div className="text-xs font-medium text-blue-700">
                    {startTime} - {endTime}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
