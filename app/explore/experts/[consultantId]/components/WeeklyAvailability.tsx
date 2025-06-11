import React from "react";
import { DayOfWeek } from "@prisma/client";

interface ProcessedSlot {
  id: string;
  localStartTime: string;
  localEndTime: string;
  originalSlot: any;
}

interface WeeklyAvailabilityProps {
  slotsByDay: Record<DayOfWeek, ProcessedSlot[]>;
  onSlotSelect: (slot: any) => void;
  selectedSlotId?: string;
}

// Helper function to round 59 minutes to next hour
const roundTime = (timeString: string): string => {
  // Parse time like "4:59 PM" or "11:59 AM"
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
  const match = timeString.match(timeRegex);
  
  if (!match) return timeString;
  
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();
  
  // Round 59 minutes to next hour
  if (minutes === 59) {
    hours += 1;
    
    // Handle hour overflow and AM/PM transition
    if (period === "AM" && hours === 12) {
      return "12:00 PM";
    } else if (period === "PM" && hours === 12) {
      return "12:00 AM";
    } else if (hours > 12) {
      return `${hours - 12}:00 ${period}`;
    } else {
      return `${hours}:00 ${period}`;
    }
  }
  
  return timeString;
};

// Helper function to convert time string to minutes for sorting
const timeToMinutes = (timeString: string): number => {
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
  const match = timeString.match(timeRegex);
  
  if (!match) return 0;
  
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();
  
  // Convert to 24-hour format
  if (period === "AM" && hours === 12) {
    hours = 0;
  } else if (period === "PM" && hours !== 12) {
    hours += 12;
  }
  
  return hours * 60 + minutes;
};

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
    const sorted: Record<DayOfWeek, ProcessedSlot[]> = {} as Record<DayOfWeek, ProcessedSlot[]>;
    
    daysOfWeek.forEach(day => {
      sorted[day] = (slotsByDay[day] || []).slice().sort((a, b) => {
        return timeToMinutes(a.localStartTime) - timeToMinutes(b.localStartTime);
      });
    });
    
    return sorted;
  }, [slotsByDay]);

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
                className={`bg-blue-50 rounded-md p-2 cursor-pointer ${
                  selectedSlotId === slot.id
                    ? "bg-blue-200"
                    : "hover:bg-blue-100"
                } transition-all duration-300 shadow-sm hover:shadow-md flex items-center justify-center`}
                onClick={() => onSlotSelect(slot.originalSlot)}
              >
                <div className="text-xs font-medium text-blue-700">
                  {roundTime(slot.localStartTime)} - {roundTime(slot.localEndTime)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
