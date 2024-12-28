import React from "react";
import { format, startOfMonth, endOfMonth, eachDayOfInterval } from "date-fns";
import { SlotOfAvailability, filterSlotsByDay, formatSlotTime } from "../utils";

interface MonthViewProps {
  currentDate: Date;
  slots: SlotOfAvailability[];
  onCellClick: (day: Date, hour: number) => void;
}

export const MonthView: React.FC<MonthViewProps> = ({
  currentDate,
  slots,
  onCellClick,
}) => {
  const days = eachDayOfInterval({
    start: startOfMonth(currentDate),
    end: endOfMonth(currentDate),
  });

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200 rounded-lg overflow-hidden">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
        <div
          key={day}
          className="text-sm font-medium text-center p-2 bg-gray-100"
        >
          {day}
        </div>
      ))}
      {days.map((day, index) => (
        <div
          key={index}
          className={`p-2 ${
            format(day, "MM") === format(currentDate, "MM")
              ? "bg-white"
              : "bg-gray-50"
          } min-h-[100px] cursor-pointer`}
          onClick={() => onCellClick(day, 9)} // Default to 9 AM for month view
        >
          <div className="text-sm font-medium mb-1">{format(day, "d")}</div>
          <div className="space-y-1">
            {filterSlotsByDay(slots, day, currentDate)
              .slice(0, 3)
              .map((slot, slotIndex) => (
                <div
                  key={slotIndex}
                  className="text-xs p-1 rounded-sm truncate bg-blue-100 text-blue-800 border border-blue-200"
                >
                  {formatSlotTime(slot)}
                </div>
              ))}
            {filterSlotsByDay(slots, day, currentDate).length > 3 && (
              <div className="text-xs text-gray-500">More...</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
