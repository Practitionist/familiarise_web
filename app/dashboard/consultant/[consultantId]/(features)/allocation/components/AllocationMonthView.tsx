import { useMemo } from "react";
import { format } from "date-fns";
import {
  getMonthDates,
  isInMonth,
  isToday,
  getTimeString,
  getSlotStyle,
  type Slot,
} from "../utils";

interface AllocationMonthViewProps {
  currentDate: Date;
  slots: Slot[];
  onCellClick: (date: Date, hour: number) => void;
}

export function AllocationMonthView({
  currentDate,
  slots,
  onCellClick,
}: Readonly<AllocationMonthViewProps>) {
  const dates = useMemo(() => getMonthDates(currentDate), [currentDate]);

  return (
    <div className="grid grid-cols-7 gap-px bg-gray-200">
      {/* Day headers */}
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
        <div
          key={day}
          className="bg-white p-2 text-center text-sm font-medium text-gray-700"
        >
          {day}
        </div>
      ))}

      {/* Calendar cells */}
      {dates.map((date) => {
        const daySlots = slots.filter((slot) => {
          const slotDate = new Date(slot.slotStartTimeInUTC);
          return (
            slotDate.getDate() === date.getDate() &&
            slotDate.getMonth() === date.getMonth() &&
            slotDate.getFullYear() === date.getFullYear()
          );
        });

        return (
          <div
            key={date.toISOString()}
            className={`min-h-[120px] bg-white p-2 ${
              !isInMonth(date, currentDate) ? "bg-gray-50" : ""
            }`}
            onClick={() => onCellClick(date, new Date().getHours())}
          >
            <div
              className={`text-sm font-medium mb-1 ${
                isToday(date) ? "text-blue-600" : "text-gray-700"
              } ${!isInMonth(date, currentDate) ? "text-gray-400" : ""}`}
            >
              {format(date, "d")}
            </div>
            <div className="space-y-1">
              {daySlots.map((slot) => (
                <div
                  key={slot.id}
                  className={`text-xs p-1 rounded ${getSlotStyle(slot)}`}
                >
                  {getTimeString(slot.slotStartTimeInUTC)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
