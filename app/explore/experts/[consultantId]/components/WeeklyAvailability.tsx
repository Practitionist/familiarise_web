import React from "react";
import { DayOfWeek } from "@prisma/client";
import { TSlotTiming } from "@/types/slots";
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

type ProcessedSlotsByDay = Record<DayOfWeek, ProcessedSlot[]>;

interface WeeklyAvailabilityProps {
  slotsByDay: ProcessedSlotsByDay;
}

export function WeeklyAvailability({ slotsByDay }: WeeklyAvailabilityProps) {
  const dayNames: DayOfWeek[] = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];

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
    <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 rounded-2xl shadow-xl border border-gray-800/50 p-6 backdrop-blur-sm">
      {/* Glossy overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-gray-800/20 to-transparent rounded-2xl pointer-events-none" />

      <div className="relative">
        <div className="grid grid-cols-7 gap-3">
          {dayNames.map((day) => (
            <div key={day} className="space-y-3">
              {/* Day header with glossy effect */}
              <div className="text-center">
                <h4 className="font-semibold text-sm text-gray-100 bg-gradient-to-b from-gray-800/80 to-gray-900/80 px-3 py-2 rounded-xl border border-gray-700/50 shadow-sm">
                  {day.charAt(0) + day.slice(1).toLowerCase()}
                </h4>
              </div>

              <div className="space-y-2">
                {slotsByDay[day]?.length > 0 ? (
                  // Sort slots chronologically within each day
                  slotsByDay[day]
                    .sort((a, b) => {
                      const timeA = timeToMinutes(roundTime(a.localStartTime));
                      const timeB = timeToMinutes(roundTime(b.localStartTime));
                      return timeA - timeB;
                    })
                    .map((slot) => {
                      const bookingStatus = slot.bookingStatus || "available";
                      const isFullyBooked = bookingStatus === "fully-booked";
                      const isPartiallyBooked =
                        bookingStatus === "partially-booked";
                      const bookedDate =
                        isFullyBooked || isPartiallyBooked
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
                  <div className="h-16 flex items-center justify-center text-xs text-gray-500 bg-gradient-to-br from-gray-800/30 to-gray-900/30 rounded-xl border border-gray-700/30 shadow-sm">
                    No slots
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
