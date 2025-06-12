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
  onSlotSelect: (slot: TSlotTiming) => void;
  selectedSlotId?: string;
}

export function WeeklyAvailability({
  slotsByDay,
  onSlotSelect,
  selectedSlotId,
}: WeeklyAvailabilityProps) {
  const dayNames: DayOfWeek[] = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];

  const handleSlotClick = (slot: ProcessedSlot) => {
    const timing: TSlotTiming = {
      slotId: slot.id,
      dateInISO: slot.slotStartTimeInUTC || "",
      dayOfWeek: dayNames.find((day) =>
        slotsByDay[day]?.some((s) => s.id === slot.id),
      ) as DayOfWeek,
      slotStartTimeInUTC: slot.slotStartTimeInUTC || "",
      slotEndTimeInUTC: slot.slotEndTimeInUTC || "",
      slotOfAvailabilityId: slot.originalSlot.id,
      slotOfAppointmentId: "",
      localStartTime: slot.localStartTime,
      localEndTime: slot.localEndTime,
      type: slot.type,
    };
    onSlotSelect(timing);
  };

  return (
    <div className="grid grid-cols-7 gap-4">
      {dayNames.map((day) => (
        <div key={day} className="space-y-2">
          <h4 className="font-medium text-sm text-gray-700">
            {day.charAt(0) + day.slice(1).toLowerCase()}
          </h4>
          <div className="space-y-1">
            {slotsByDay[day]?.length > 0 ? (
              // Sort slots chronologically within each day
              slotsByDay[day]
                .sort((a, b) => {
                  const timeA = timeToMinutes(roundTime(a.localStartTime));
                  const timeB = timeToMinutes(roundTime(b.localStartTime));
                  return timeA - timeB;
                })
                .map((slot) => {
                  const isSelected = selectedSlotId === slot.id;
                  const bookingStatus = slot.bookingStatus || "available";
                  const isFullyBooked = bookingStatus === "fully-booked";
                  const isPartiallyBooked =
                    bookingStatus === "partially-booked";

                  return (
                    <button
                      key={slot.id}
                      onClick={() => handleSlotClick(slot)}
                      disabled={isFullyBooked}
                      className={`w-full p-2 text-xs rounded transition-colors ${
                        isSelected
                          ? "bg-blue-500 text-white"
                          : isFullyBooked
                            ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                            : isPartiallyBooked
                              ? "bg-amber-100 border border-amber-300 text-amber-800 hover:bg-amber-200"
                              : "bg-gray-100 hover:bg-gray-200 text-gray-700"
                      }`}
                    >
                      <div className="space-y-1">
                        <div>
                          {roundTime(slot.localStartTime)} -{" "}
                          {roundTime(slot.localEndTime)}
                        </div>
                        {isFullyBooked && (
                          <div className="text-xs font-medium">Booked</div>
                        )}
                        {isPartiallyBooked && (
                          <div className="text-xs font-medium">
                            Partially Booked
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })
            ) : (
              <div className="text-xs text-gray-400 p-2">No slots</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
