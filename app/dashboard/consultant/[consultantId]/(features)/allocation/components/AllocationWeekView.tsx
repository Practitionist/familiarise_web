import React, { useMemo } from "react";
import { format } from "date-fns";
import {
  getWeekDates,
  isToday,
  getTimeString,
  getSlotStyle,
  HOURS,
  type Slot,
} from "../utils";

interface AllocationWeekViewProps {
  currentDate: Date;
  slots: Slot[];
  onCellClick: (date: Date, hour: number) => void;
}

export function AllocationWeekView({
  currentDate,
  slots,
  onCellClick,
}: Readonly<AllocationWeekViewProps>) {
  const dates = useMemo(() => getWeekDates(currentDate), [currentDate]);

  return (
    <div className="grid grid-cols-[auto,1fr] divide-x divide-gray-200">
      {/* Time labels */}
      <div className="pr-4">
        <div className="h-12 border-b border-gray-200" /> {/* Header spacer */}
        {HOURS.map((hour) => (
          <div
            key={hour}
            className="h-12 flex items-center justify-end text-sm text-gray-500"
          >
            {format(new Date().setHours(hour), "ha")}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 divide-x divide-gray-200">
        {/* Day headers */}
        {dates.map((date) => (
          <div
            key={date.toISOString()}
            className={`h-12 p-2 text-center border-b border-gray-200 ${
              isToday(date) ? "bg-blue-50" : ""
            }`}
          >
            <div className="text-sm font-medium text-gray-900">
              {format(date, "EEE")}
            </div>
            <div
              className={`text-sm ${
                isToday(date) ? "text-blue-600" : "text-gray-500"
              }`}
            >
              {format(date, "d")}
            </div>
          </div>
        ))}

        {/* Time slots */}
        {HOURS.map((hour) => (
          <React.Fragment key={hour}>
            {dates.map((date) => {
              const cellDate = new Date(date);
              cellDate.setHours(hour);

              const cellSlots = slots.filter((slot) => {
                const slotDate = new Date(slot.slotStartTimeInUTC);
                return (
                  slotDate.getDate() === date.getDate() &&
                  slotDate.getMonth() === date.getMonth() &&
                  slotDate.getFullYear() === date.getFullYear() &&
                  slotDate.getHours() === hour
                );
              });

              return (
                <div
                  key={date.toISOString()}
                  className="h-12 border-b border-gray-200 p-1"
                  onClick={() => onCellClick(date, hour)}
                >
                  {cellSlots.map((slot) => (
                    <div
                      key={slot.id}
                      className={`text-xs p-1 rounded ${getSlotStyle(slot)}`}
                    >
                      {getTimeString(slot.slotStartTimeInUTC)}
                    </div>
                  ))}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
