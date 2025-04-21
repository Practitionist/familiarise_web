import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DAYS,
  DetailedTimeSlotMeta,
  getSlotStatus,
  INTERVALS,
  TimeSlotMeta
} from "@/lib/timeSlotsMeta";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { format } from "date-fns";

type TimingsCalendarProps = {
  availableSlots: TimeSlotMeta[] | undefined;
  existingAppointments: DetailedTimeSlotMeta[] | undefined;
  onSlotSelect: (slotStartTimeUTC: string) => void;
  selectedSlots: string[] | undefined;
  requiredSlots: number;
  scheduleType: "WEEKLY" | "CUSTOM";
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

  const renderTimeCell = (
    baseDate: Date,
    interval: { hour: number; minute: number },
  ) => {
    const status = getSlotStatus(
      interval,
      baseDate,
      availableSlots,
      existingAppointments,
    );

    const intervalStartStringUTC = status.intervalStartUTCString;
    const isSelected = selectedSlots.includes(intervalStartStringUTC);

    const isButtonDisabled = status.isDisabled;

    let cellClassName =
      "h-8 w-full relative text-[10px] leading-tight px-1 py-0.5 transition-colors duration-150 ease-in-out border border-transparent rounded-sm ";
    let buttonText = "";

    if (isSelected) {
      cellClassName +=
        "bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
      buttonText = "Selected";
    } else if (status.isBookedForDisplay) {
      cellClassName += "bg-slate-400 text-slate-800 cursor-not-allowed";
      buttonText = "Booked";
    } else if (status.isPartiallyBooked) {
      cellClassName += "bg-yellow-400 text-yellow-900 cursor-not-allowed";
      buttonText = "Partially Booked";
    } else if (status.isAvailable) {
      if (status.isInPast) {
        cellClassName +=
          "bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
        buttonText = "Available";
      } else {
        cellClassName +=
          "bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
        buttonText = "Available";
      }
    } else {
      if (status.isInPast) {
        cellClassName +=
          "bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
      } else if (!status.isBookedForDisplay && !status.isPartiallyBooked) {
        cellClassName += "bg-slate-300 cursor-not-allowed";
      }
    }

    const buttonElement = (
      <Button
        key={intervalStartStringUTC}
        variant={"ghost"}
        className={cellClassName}
        onClick={() => !isButtonDisabled && onSlotSelect(intervalStartStringUTC)}
        disabled={isButtonDisabled && !isSelected}
      >
        {buttonText}
      </Button>
    );

    if (status.isBooked && status.overlappingAppointments.length > 0) {
      const tooltipButtonElement = (
        <Button
          key={`${intervalStartStringUTC}-tooltip-trigger`}
          variant={"ghost"}
          className={cellClassName}
          onClick={() => !isButtonDisabled && onSlotSelect(intervalStartStringUTC)}
          disabled={false}
        >
          {buttonText}
        </Button>
      );

      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              {tooltipButtonElement}
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs" side="top" align="center">
              <div className="flex flex-col gap-1">
                {status.overlappingAppointments.map((appSlot) => (
                  <div
                    key={
                      appSlot.appointmentDetails?.id +
                      (appSlot.startTime instanceof Date ? appSlot.startTime.toISOString() : new Date(appSlot.startTime).toISOString())
                    }
                    className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                  >
                    <p className="font-semibold">
                      {appSlot.appointmentDetails?.title || "Booked Slot"}
                    </p>
                    <p className="text-muted-foreground">
                      {appSlot.appointmentDetails?.type}
                    </p>
                    <p className="text-muted-foreground">
                      {format(appSlot.startTime instanceof Date ? appSlot.startTime : new Date(appSlot.startTime), "HH:mm")} -{" "}
                      {format(appSlot.endTime instanceof Date ? appSlot.endTime : new Date(appSlot.endTime), "HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return buttonElement;
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
          {INTERVALS.map((interval, i) => (
            <div
              key={`interval-row-${i}`}
              className="grid grid-cols-8 gap-0.5 md:gap-1"
            >
              <div className="w-14 md:w-20">
                <div
                  key={`time-label-${i}`}
                  className="h-8 text-right pr-2 pt-0.5 text-[10px] md:text-sm flex items-start justify-end"
                >
                  {new Date(
                    1970,
                    0,
                    1,
                    interval.hour,
                    interval.minute,
                  ).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: browserTimezone,
                    hour12: false,
                  })}
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
    const currentDayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);

      const dayAvailableSlots = availableSlots.filter((slot) => {
        const slotStart =
          slot.startTime instanceof Date
            ? slot.startTime
            : new Date(slot.startTime);
        const slotEnd =
          slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
        return slotStart < dayEnd && slotEnd > dayStart;
      });
      const dayExistingAppointments = existingAppointments.filter((slot) => {
        const slotStart =
          slot.startTime instanceof Date
            ? slot.startTime
            : new Date(slot.startTime);
        const slotEnd =
          slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
        return slotStart < dayEnd && slotEnd > dayStart;
      });

      for (const interval of INTERVALS) {
        const status = getSlotStatus(
          interval,
          date,
          dayAvailableSlots,
          dayExistingAppointments,
        );

        if (status.isAvailable && !status.isInPast) {
          count++;
        }
      }
      return count;
    };

    return (
      <div className="grid grid-cols-7 gap-0.5 md:gap-1 h-[calc(100vh-20rem)] md:h-[65vh] max-h-[600px]">
        {DAYS.map((day) => (
          <div
            key={day}
            className="text-center font-bold p-1 md:p-2 text-xs md:text-base"
          >
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
                <div
                  className={`font-bold bg-background/95 backdrop-blur p-1 flex justify-between items-center text-xs md:text-sm ${isToday ? "text-primary" : ""}`}
                >
                  <span>{i + 1}</span>
                  {availableCount > 0 && !isPast && (
                    <Badge variant="outline" className="text-[10px] md:text-xs">
                      {availableCount} slots
                    </Badge>
                  )}
                </div>
                <div className="flex-1 text-center text-xs text-muted-foreground pt-2 md:pt-4">
                  {isPast ? "" : availableCount === 0 ? "No Slots" : ""}
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
        <Button
          variant="outline"
          size="sm"
          onClick={navigatePrevious}
          className="p-1 md:p-2"
        >
          <ChevronLeft className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
        <div className="text-sm md:text-lg font-bold truncate px-2">
          {currentDate.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={navigateNext}
          className="p-1 md:p-2"
        >
          <ChevronRight className="h-3 w-3 md:h-4 md:w-4" />
        </Button>
      </div>
      <div className="flex justify-end gap-1 md:gap-2 mb-1 md:mb-2">
        <Button
          variant={view === "week" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("week")}
          className="text-xs md:text-sm px-2 md:px-3"
        >
          Week
        </Button>
        <Button
          variant={view === "month" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("month")}
          className="text-xs md:text-sm px-2 md:px-3"
        >
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
