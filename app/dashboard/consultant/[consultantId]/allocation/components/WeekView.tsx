import React from "react";
import { format, startOfWeek, addDays } from "date-fns";
import {
  SlotOfAvailability,
  filterSlotsByDay,
  formatSlotTime,
  calculateSlotPosition,
} from "../utils";

interface WeekViewProps {
  currentDate: Date;
  slots: SlotOfAvailability[];
  onCellClick: (day: Date, hour: number) => void;
}

export const WeekView: React.FC<WeekViewProps> = ({
  currentDate,
  slots,
  onCellClick,
}) => {
  const days = Array.from({ length: 7 }, (_, i) =>
    addDays(startOfWeek(currentDate), i),
  );

  return (
    <div className="grid grid-cols-8 gap-px bg-gray-200">
      <div className="col-span-1 bg-white">
        <div className="h-12 border-b border-gray-200"></div>
        <div className="relative" style={{ height: "calc(24 * 3rem)" }}>
          {Array.from({ length: 25 }, (_, i) => (
            <div
              key={i}
              className="absolute w-full text-xs text-right pr-2 flex items-center justify-end"
              style={{
                top:
                  i === 0 ? "0" : i === 24 ? "calc(24 * 3rem)" : `${i * 3}rem`,
                transform:
                  i === 0
                    ? "translateY(0)"
                    : i === 24
                      ? "translateY(-100%)"
                      : "translateY(-50%)",
              }}
            >
              {format(new Date().setHours(i % 24, 0, 0, 0), "h a")}
            </div>
          ))}
        </div>
      </div>
      {days.map((day, dayIndex) => (
        <div key={dayIndex} className="col-span-1 bg-white">
          <div className="h-12 text-sm font-medium p-2 text-center border-b border-gray-200">
            {format(day, "EEE dd")}
          </div>
          <div className="relative" style={{ height: "calc(24 * 3rem)" }}>
            {Array.from({ length: 24 }, (_, i) => (
              <div
                key={i}
                className="absolute w-full border-b border-gray-100 cursor-pointer"
                style={{ top: `${i * 3}rem`, height: "3rem" }}
                onClick={() => onCellClick(day, i)}
              ></div>
            ))}
            {filterSlotsByDay(slots, day, currentDate).map(
              (slot, slotIndex) => {
                const { top, height } = calculateSlotPosition(slot);
                return (
                  <div
                    key={slotIndex}
                    className="absolute left-0 right-0 bg-blue-500 text-white rounded-sm shadow-sm"
                    style={{ top, height, margin: "1px" }}
                  >
                    <div className="text-xs p-1 truncate">
                      {formatSlotTime(slot)}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
