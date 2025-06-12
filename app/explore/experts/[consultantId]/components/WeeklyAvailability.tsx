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
    <div className="bg-gradient-to-br from-white via-gray-50/50 to-white rounded-2xl shadow-xl border border-gray-200/50 p-6 backdrop-blur-sm">
      {/* Glossy overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-2xl pointer-events-none" />

      <div className="relative">
        <div className="grid grid-cols-7 gap-3">
          {dayNames.map((day) => (
            <div key={day} className="space-y-3">
              {/* Day header with glossy effect */}
              <div className="text-center">
                <h4 className="font-semibold text-sm text-gray-800 bg-gradient-to-b from-gray-100 to-gray-200/80 px-3 py-2 rounded-xl border border-gray-300/50 shadow-sm">
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
                                ? "bg-gradient-to-br from-gray-300 to-gray-400 text-gray-600 border-gray-300 shadow-gray-400/20"
                                : isPartiallyBooked
                                  ? "bg-gradient-to-br from-amber-200 to-amber-300 border-amber-400 text-amber-900 shadow-amber-400/25"
                                  : "bg-gradient-to-br from-emerald-100 to-emerald-200 text-emerald-800 border-emerald-300 shadow-emerald-400/20"
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

                            {/* Status and date for booked slots */}
                            {isFullyBooked && (
                              <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                                Booked
                                <br />
                                {bookedDate && `(${bookedDate})`}
                              </div>
                            )}
                            {isPartiallyBooked && (
                              <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                                Partially
                                <br />
                                Booked {bookedDate && `(${bookedDate})`}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                ) : (
                  <div className="h-16 flex items-center justify-center text-xs text-gray-400 bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl border border-gray-200 shadow-sm">
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
