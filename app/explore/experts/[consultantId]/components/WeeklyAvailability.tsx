import React, { useMemo, useState } from "react";
import { DayOfWeek } from "@prisma/client";
import { ChevronDown, ChevronUp } from "lucide-react";
import { roundTime, timeToMinutes } from "../utils/time";
import { mergeConsecutiveSlotsForDisplay } from "../utils/mergeSlots";
import type { ProcessedSlot } from "../types";

type ProcessedSlotsByDay = Record<DayOfWeek, ProcessedSlot[]>;

interface WeeklyAvailabilityProps {
  slotsByDay: ProcessedSlotsByDay;
}

const VISIBLE_SLOT_COUNT = 5;

const DAY_NAMES: DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

export function WeeklyAvailability({ slotsByDay }: WeeklyAvailabilityProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const mergedSlotsByDay = useMemo(() => {
    const result: Record<DayOfWeek, ProcessedSlot[]> = {} as Record<
      DayOfWeek,
      ProcessedSlot[]
    >;
    for (const day of DAY_NAMES) {
      const sorted = (slotsByDay[day] || []).slice().sort((a, b) => {
        return (
          timeToMinutes(roundTime(a.localStartTime)) -
          timeToMinutes(roundTime(b.localStartTime))
        );
      });
      result[day] = mergeConsecutiveSlotsForDisplay(sorted);
    }
    return result;
  }, [slotsByDay]);

  // Check if any day has more slots than the visible limit
  const totalHidden = useMemo(() => {
    return DAY_NAMES.reduce((sum, day) => {
      const excess = mergedSlotsByDay[day].length - VISIBLE_SLOT_COUNT;
      return sum + (excess > 0 ? excess : 0);
    }, 0);
  }, [mergedSlotsByDay]);

  // Get the date for booked slots in user timezone
  const getBookedSlotDate = (slot: ProcessedSlot) => {
    if (!slot.startsAt) return "";
    const date = new Date(slot.startsAt);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="bg-card rounded-2xl border border-border shadow-elevation-1 p-6">
      <div className="relative">
        <div className="grid grid-cols-7 gap-3">
          {DAY_NAMES.map((day) => {
            const allSlots = mergedSlotsByDay[day];
            const visibleSlots = isExpanded
              ? allSlots
              : allSlots.slice(0, VISIBLE_SLOT_COUNT);

            return (
              <div key={day} className="space-y-3">
                {/* Day header */}
                <div className="text-center">
                  <h4 className="font-semibold text-sm text-foreground bg-muted px-3 py-2 rounded-xl border border-border">
                    {day.charAt(0) + day.slice(1).toLowerCase()}
                  </h4>
                </div>

                <div className="space-y-2">
                  {visibleSlots.length > 0 ? (
                    visibleSlots.map((slot) => {
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
                            border relative overflow-hidden
                            ${
                              isFullyBooked
                                ? "bg-muted text-muted-foreground border-border"
                                : isPartiallyBooked
                                  ? "bg-amber-50 border-amber-200 text-amber-800"
                                  : "bg-emerald-50 border-emerald-200 text-emerald-700"
                            }
                          `}
                        >
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
                    <div className="h-16 flex items-center justify-center text-xs text-muted-foreground/70 bg-muted rounded-xl border border-border">
                      No slots
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Single expand/collapse button for the entire week */}
        {totalHidden > 0 && (
          <div className="flex justify-center mt-4">
            <button
              onClick={() => setIsExpanded((prev) => !prev)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 rounded-xl border border-emerald-200 transition-colors cursor-pointer"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Show {totalHidden} more slots
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
