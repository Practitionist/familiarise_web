import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";
import React, { useState, useEffect, useMemo } from "react";
import { SlotInterval } from "../types";

type TimingsCalendarProps = {
  availableSlots: SlotInterval[] | undefined;
  existingAppointments: SlotInterval[] | undefined;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  scheduleType: "WEEKLY" | "CUSTOM";
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS_PER_HOUR = 2;
const TOTAL_INTERVALS = 24 * INTERVALS_PER_HOUR;
const INTERVALS = Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
  const hour = Math.floor(i / INTERVALS_PER_HOUR);
  const minute = (i % INTERVALS_PER_HOUR) * (60 / INTERVALS_PER_HOUR);
  return { hour, minute };
});

const isOverlapping = (
  intervalStart: Date,
  intervalEnd: Date,
  slotList: SlotInterval[] = [],
): boolean => {
  return slotList.some((slot) => {
    const slotStart = new Date(slot.slotStartTimeInUTC);
    const slotEnd = new Date(slot.slotEndTimeInUTC);
    return intervalStart < slotEnd && slotStart < intervalEnd;
  });
};

export function TimingsCalendar({
  availableSlots = [],
  existingAppointments = [],
  onSlotSelect,
  selectedSlots = [],
  requiredSlots,
  scheduleType,
}: TimingsCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");

  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const navigatePrevious = () => {
    setCurrentDate((prevDate) => {
      const newDate = new Date(prevDate);
      newDate.setDate(newDate.getDate() - (view === "week" ? 7 : 30));
      return newDate;
    });
  };

  const navigateNext = () => {
    setCurrentDate((prevDate) => {
      const newDate = new Date(prevDate);
      newDate.setDate(newDate.getDate() + (view === "week" ? 7 : 30));
      return newDate;
    });
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const weekViewDates = useMemo(() => {
    const startOfWeek = new Date(currentDate);
    startOfWeek.setDate(currentDate.getDate() - currentDate.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    return Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + dayIndex);
      return date;
    });
  }, [currentDate]);

  const { minHour, maxHour } = useMemo(() => {
    let min = 9;
    let max = 17;
    const weekStart = weekViewDates[0];
    const weekEnd = new Date(weekViewDates[6]);
    weekEnd.setHours(23, 59, 59, 999);

    const relevantSlots = [
        ...(availableSlots || []),
        ...(existingAppointments || [])
    ].filter(slot => {
        const slotStart = new Date(slot.slotStartTimeInUTC);
        return slotStart >= weekStart && slotStart <= weekEnd;
    });

    if (relevantSlots.length > 0) {
        min = 24;
        max = 0;
        relevantSlots.forEach(slot => {
            const startHour = new Date(slot.slotStartTimeInUTC).getHours();
            const endHour = new Date(slot.slotEndTimeInUTC).getHours();
            const endMinute = new Date(slot.slotEndTimeInUTC).getMinutes();

            if (startHour < min) min = startHour;
            const effectiveEndHour = endMinute === 0 ? endHour : endHour + 1;
            if (effectiveEndHour > max) max = effectiveEndHour;
        });
        
        min = Math.max(0, min - 1);
        max = Math.min(24, max);
    }

    if (min >= max) {
        min = 8;
        max = 18;
    }

    return { minHour: min, maxHour: max };
  }, [weekViewDates, availableSlots, existingAppointments]);

  const visibleIntervals = useMemo(() => {
      return INTERVALS.filter(interval => interval.hour >= minHour && interval.hour < maxHour);
  }, [minHour, maxHour]);

  const renderTimeCell = (
    baseDate: Date,
    interval: { hour: number; minute: number },
  ) => {
    const intervalStartDateUTC = new Date(baseDate);
    intervalStartDateUTC.setUTCHours(interval.hour, interval.minute, 0, 0);

    const intervalEndDateUTC = new Date(intervalStartDateUTC);
    intervalEndDateUTC.setUTCMinutes(intervalStartDateUTC.getUTCMinutes() + 30);

    const intervalStartStringUTC = intervalStartDateUTC.toISOString();

    // Check status
    const isWithinAvailability = isOverlapping(
      intervalStartDateUTC,
      intervalEndDateUTC,
      availableSlots,
    );
    const isBooked = isOverlapping(
      intervalStartDateUTC,
      intervalEndDateUTC,
      existingAppointments,
    );
    const isSelected = selectedSlots.includes(intervalStartStringUTC);
    const now = new Date();
    const isInPast = intervalEndDateUTC < now;

    const isDisabled = !isWithinAvailability || isBooked || isInPast;

    let cellClassName = "h-8 w-full relative text-[10px] leading-tight px-1 py-0.5 transition-colors duration-150 ease-in-out border border-transparent rounded-sm ";
    if (isSelected) {
        cellClassName += "bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
    } else if (isBooked) {
        cellClassName += "bg-slate-400 text-slate-800 cursor-not-allowed";
    } else if (isWithinAvailability) {
        if (isInPast) {
            cellClassName += "bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
        } else {
            cellClassName += "bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
        }
    } else {
        if (isInPast) {
             cellClassName += "bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
        } else {
             cellClassName += "bg-slate-300 cursor-not-allowed";
        }
    }

    // Determine button text separately
    const buttonText = isBooked
      ? "Booked"
      : isSelected
        ? "Selected"
        : isWithinAvailability // Show "Available" even if in the past, rely on disabled state
          ? "Available"
          : "";

    return (
      <Button
        key={intervalStartStringUTC}
        variant={"ghost"}
        className={cellClassName}
        onClick={() => !isDisabled && onSlotSelect(intervalStartStringUTC)}
        disabled={isDisabled}
      >
        {buttonText}
      </Button>
    );
  };

  const renderWeekView = () => {
    return (
      <div className="flex flex-col h-[calc(100vh-20rem)] md:h-[65vh] max-h-[700px]">
        <div className="grid grid-cols-8 gap-0.5 md:gap-1 sticky top-0 bg-background z-20 pb-1">
          <div className="w-14 md:w-20"></div>
          {weekViewDates.map((date, index) => {
            const isToday = date.toDateString() === new Date().toDateString();
            return (
              <div key={DAYS[index]} className="text-center p-1 md:p-2">
                <div
                  className={`font-bold text-xs md:text-base ${isToday ? "text-primary" : ""}`}
                >
                  {DAYS[index].slice(0, 3)}
                </div>
                <div className="text-xs md:text-sm text-muted-foreground">
                  {date.getDate()}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {visibleIntervals.map((interval, i) => (
            <div key={`interval-row-${i}`} className="grid grid-cols-8 gap-0.5 md:gap-1">
              <div className="w-14 md:w-20">
                <div
                  key={`time-label-${i}`}
                  className="h-8 text-right pr-2 py-0.5 text-[10px] md:text-sm flex items-center justify-end"
                >
                  {new Date(1970, 0, 1, interval.hour, interval.minute).toLocaleTimeString(
                      [],
                      {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: browserTimezone,
                        hour12: false,
                      },
                  )}
                </div>
              </div>
              {weekViewDates.map((date) => (
                <div key={date.toISOString()} className="col-span-1">
                  {renderTimeCell(date, interval)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderMonthView = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
       let count = 0;
       const dayStart = new Date(date);
       dayStart.setHours(0, 0, 0, 0);
       const dayEnd = new Date(date);
       dayEnd.setHours(23, 59, 59, 999);

       const relevantAvailability = availableSlots.filter(slot => {
          const slotStart = new Date(slot.slotStartTimeInUTC);
          const slotEnd = new Date(slot.slotEndTimeInUTC);
          return slotStart < dayEnd && slotEnd > dayStart;
       });
       const relevantAppointments = existingAppointments.filter(slot => {
          const slotStart = new Date(slot.slotStartTimeInUTC);
          const slotEnd = new Date(slot.slotEndTimeInUTC);
          return slotStart < dayEnd && slotEnd > dayStart;
       });

        for (const interval of INTERVALS) {
            const intervalStartDateUTC = new Date(date);
            intervalStartDateUTC.setUTCHours(interval.hour, interval.minute, 0, 0);
            const intervalEndDateUTC = new Date(intervalStartDateUTC);
            intervalEndDateUTC.setUTCMinutes(intervalStartDateUTC.getUTCMinutes() + 30);

            if (intervalEndDateUTC <= now) continue;

            const isAvail = isOverlapping(intervalStartDateUTC, intervalEndDateUTC, relevantAvailability);
            const isBooked = isOverlapping(intervalStartDateUTC, intervalEndDateUTC, relevantAppointments);

            if (isAvail && !isBooked) {
                count++;
            }
        }
        return count;
    };

    return (
      <div className="grid grid-cols-7 gap-0.5 md:gap-1 h-[calc(100vh-20rem)] md:h-[65vh] max-h-[600px]">
        {DAYS.map((day) => (
          <div key={day} className="text-center font-bold p-1 md:p-2 text-xs md:text-base">
             {window.innerWidth < 768 ? day.slice(0, 1) : day}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div key={`empty-${i}`} className="h-full bg-gray-50/50"></div>
        ))}
        {Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => {
          const date = new Date(year, month, i + 1);
          const isToday = date.toDateString() === now.toDateString();
          const isPast = date < currentDayStart;
          const availableCount = isPast ? 0 : countAvailableSlotsForDay(date);

          return (
            <Card
              key={i}
              className={`h-full min-h-[60px] md:min-h-[100px] ${isToday ? "ring-2 ring-primary" : ""} ${isPast ? "bg-gray-50" : ""}`}
            >
              <CardContent className="p-0.5 md:p-1 h-full flex flex-col">
                <div className={`font-bold bg-background/95 backdrop-blur p-1 flex justify-between items-center text-xs md:text-sm ${isToday ? "text-primary" : ""}`}>
                  <span>{i + 1}</span>
                  {availableCount > 0 && !isPast && (
                    <Badge variant="outline" className="text-[10px] md:text-xs">
                      {availableCount} slots
                    </Badge>
                  )}
                 </div>
                 <div className="flex-1 text-center text-xs text-muted-foreground pt-2 md:pt-4">
                   {isPast ? '' : availableCount === 0 ? 'No Slots' : ''}
                 </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full max-w-[100vw] overflow-x-hidden">
      <div className="flex justify-between items-center mb-1 md:mb-4">
        <Button variant="outline" size="sm" onClick={navigatePrevious} className="p-1 md:p-2">
          <ChevronLeft className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
        <div className="text-sm md:text-lg font-bold truncate px-2">
          {currentDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        <Button variant="outline" size="sm" onClick={navigateNext} className="p-1 md:p-2">
          <ChevronRight className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
      </div>
      <div className="flex justify-end gap-1 md:gap-2 mb-1 md:mb-2">
        <Button variant={view === "week" ? "default" : "outline"} size="sm" onClick={() => setView("week")} className="text-xs md:text-sm px-2 md:px-3">
          Week
        </Button>
        <Button variant={view === "month" ? "default" : "outline"} size="sm" onClick={() => setView("month")} className="text-xs md:text-sm px-2 md:px-3">
          Month
        </Button>
      </div>
      {view === "week" ? renderWeekView() : renderMonthView()}
      <div className="mt-1 md:mt-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-1 md:gap-0">
          <div className="text-xs md:text-sm">
            Selected: {selectedSlots.length} / {requiredSlots}
          </div>
          <div className="text-xs md:text-sm text-muted-foreground">
            Timezone: {browserTimezone}
          </div>
        </div>
      </div>
    </div>
  );
}
