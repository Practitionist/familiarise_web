import React from "react";
import { TSlotTiming } from "@/types/slots";
import { DayOfWeek } from "@prisma/client";
import { roundTime, timeToMinutes } from "../utils/time";

// Better typing for original slot data
type OriginalSlotData = {
  id: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
};

interface ProcessedSlot {
  id: string;
  localStartTime: string;
  localEndTime: string;
  originalSlot: OriginalSlotData;
  isAllocated?: boolean;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
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

  // Get the date for booked slots in user timezone
  const getBookedSlotDate = (slot: ProcessedSlot) => {
    if (!slot.slotStartTimeInUTC) return "";
    const date = new Date(slot.slotStartTimeInUTC);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 rounded-2xl shadow-xl border border-gray-800/50 p-8 backdrop-blur-sm relative">
      {/* Glossy overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-gray-800/20 to-transparent rounded-2xl pointer-events-none" />

      <div className="relative">
        <h3 className="text-2xl font-bold mb-6 text-center text-gray-100">
          Custom Availability
        </h3>

        {/* Date headers with glossy effect */}
        <div className="grid grid-cols-7 gap-4 mb-6">
          {sortedDays.map(({ date }) => (
            <div key={date.toISOString()} className="text-center">
              <div className="bg-gradient-to-b from-gray-800/80 to-gray-900/80 px-3 py-2 rounded-xl border border-gray-700/50 shadow-sm">
                <div className="text-sm font-semibold text-gray-100">
                  {date.toLocaleDateString(undefined, { weekday: "short" })}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {date.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Slots grid */}
        <div className="grid grid-cols-7 gap-4">
          {sortedDays.map(({ date, slots: daySlots }) => (
            <div key={date.toISOString()} className="space-y-2">
              {daySlots.length > 0 ? (
                daySlots.map((slot) => {
                  const bookingStatus = slot.bookingStatus || "available";
                  const isFullyBooked = bookingStatus === "fully-booked";
                  const isPartiallyBooked =
                    bookingStatus === "partially-booked";
                  const bookedDate =
                    isFullyBooked || isPartiallyBooked || slot.isAllocated
                      ? getBookedSlotDate(slot)
                      : "";

                  return (
                    <div
                      key={slot.id}
                      className={`
                        w-full min-h-[4.5rem] px-2 py-2 text-xs rounded-xl
                        border shadow-lg backdrop-blur-sm relative overflow-hidden
                        ${
                          isFullyBooked
                            ? "bg-gradient-to-br from-gray-700 to-gray-800 text-gray-300 border-gray-600 shadow-gray-700/20"
                            : isPartiallyBooked
                              ? "bg-gradient-to-br from-gray-700/70 to-gray-800/70 border-gray-600/60 text-gray-200 shadow-gray-700/25"
                              : slot.isAllocated
                                ? "bg-gradient-to-br from-gray-700/60 to-gray-800/60 border-gray-600/50 text-gray-300 shadow-gray-700/20"
                                : "bg-gradient-to-br from-gray-600/50 to-gray-700/50 text-gray-200 border-gray-500/50 shadow-gray-700/20"
                        }
                      `}
                    >
                      {/* Glossy overlay for buttons */}
                      <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-xl pointer-events-none" />

                      <div className="relative flex flex-col items-center justify-center h-full space-y-1">
                        {/* Time range in one line */}
                        <div className="font-medium leading-tight text-center text-[11px]">
                          {roundTime(slot.localStartTime)} -{" "}
                          {roundTime(slot.localEndTime)}
                        </div>

                        {/* Status labels for all slot types */}
                        {isFullyBooked ? (
                          <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                            Booked
                            <br />
                            {bookedDate && `(${bookedDate})`}
                          </div>
                        ) : isPartiallyBooked ? (
                          <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                            Partially
                            <br />
                            Booked {bookedDate && `(${bookedDate})`}
                          </div>
                        ) : slot.isAllocated ? (
                          <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                            Request
                            <br />
                            Approval {bookedDate && `(${bookedDate})`}
                          </div>
                        ) : (
                          <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                            Available
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="min-h-[4.5rem] flex items-center justify-center text-xs text-gray-500 bg-gradient-to-br from-gray-800/30 to-gray-900/30 rounded-xl border border-gray-700/30 shadow-sm">
                  No slots
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
