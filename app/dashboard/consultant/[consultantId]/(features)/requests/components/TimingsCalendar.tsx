import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DetailedTimeSlotMeta, getSlotStatus, TimeSlotMeta } from "@/utils/timeSlotsMeta";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { useMemo, useState, useEffect } from "react";
import {
  calculateTotalAvailableSlots,
  getWeekViewDates,
  navigateDate,
  getDaysInMonth,
  countAvailableSlotsForDay,
  getBrowserTimezone,
} from "../utils";
import React from "react";

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
    setBrowserTimezone(getBrowserTimezone());
  }, []);

  // Calculate total available slots using utility function
  const totalAvailableSlots = useMemo(() => {
    return calculateTotalAvailableSlots(availableSlots, existingAppointments);
  }, [availableSlots, existingAppointments]);

  const showWarning = totalAvailableSlots < requiredSlots;

  const navigatePrevious = () => {
    setCurrentDate(navigateDate(currentDate, "previous", view));
  };

  const navigateNext = () => {
    setCurrentDate(navigateDate(currentDate, "next", view));
  };

  const weekViewDates = useMemo(() => {
    return getWeekViewDates(currentDate);
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

    // Check for true booking conflicts (multiple appointments overlapping the same time)
    const hasBookingConflict = status.overlappingAppointments.length > 1;

    let cellClassName =
      "h-8 w-full relative text-[10px] leading-tight px-1 py-0.5 transition-colors duration-150 ease-in-out border border-transparent rounded-sm ";
    let buttonText = "";

    if (isSelected) {
      cellClassName +=
        "bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
      buttonText = "Selected";
    } else if (hasBookingConflict) {
      // Red color for booking conflicts (multiple overlapping appointments)
      cellClassName += "bg-red-500 text-red-50 cursor-not-allowed border-red-600";
      cellClassName += status.isInPast ? " opacity-50" : "";
      buttonText = "Booking Conflict";
    } else if (status.isBookedForDisplay) {
      cellClassName += "bg-slate-400 text-slate-800 cursor-not-allowed";
      cellClassName += status.isInPast ? " opacity-50" : "";
      buttonText = "Booked";
    } else if (status.isPartiallyBooked) {
      cellClassName += "bg-yellow-400 text-yellow-900 cursor-not-allowed";
      cellClassName += status.isInPast ? " opacity-50" : "";
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
        onClick={() =>
          !isButtonDisabled && onSlotSelect(intervalStartStringUTC)
        }
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
          onClick={() =>
            !isButtonDisabled && onSlotSelect(intervalStartStringUTC)
          }
          disabled={false}
        >
          {buttonText}
        </Button>
      );

      return (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{tooltipButtonElement}</TooltipTrigger>
            <TooltipContent
              className="max-w-xs text-xs"
              side="top"
              align="center"
            >
              <div className="flex flex-col gap-1">
                {hasBookingConflict && (
                  <div className="bg-red-100 text-red-800 px-2 py-1 rounded text-center font-semibold mb-2">
                    ⚠️ SCHEDULING CONFLICT
                  </div>
                )}
                {status.overlappingAppointments.map((appSlot) => (
                  <div
                    key={
                      appSlot.appointmentDetails?.id +
                      (appSlot.startTime instanceof Date
                        ? appSlot.startTime.toISOString()
                        : new Date(appSlot.startTime).toISOString())
                    }
                    className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                  >
                    <div className="font-medium">
                      {appSlot.appointmentDetails?.title}
                    </div>
                    <div className="text-muted-foreground">
                      {appSlot.appointmentDetails?.type}
                    </div>
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
    const timeIntervals = Array.from({ length: 48 }, (_, i) => {
      const hour = Math.floor(i / 2);
      const minute = (i % 2) * 30;
      return { hour, minute };
    });

    return (
      <div className="flex flex-col">
        {/* Fixed header with day names */}
        <div className="grid grid-cols-8 gap-1 mb-1 bg-white sticky top-0 z-10 border-b pb-1">
          <div className="font-medium text-center py-1 px-1 text-xs">Time</div>
          {weekViewDates.map((date) => (
            <div key={date.toDateString()} className="font-medium text-center py-1 px-1 text-xs">
              {date.toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </div>
          ))}
        </div>

        {/* Scrollable time slots container */}
        <div className="max-h-96 overflow-y-auto border rounded-md">
          <div className="grid grid-cols-8 gap-1">
            {timeIntervals.map((interval) => (
              <React.Fragment key={`interval-${interval.hour}-${interval.minute}`}>
                <div className="text-center p-1 text-xs font-medium border-r bg-gray-50 sticky left-0">
                  {`${interval.hour.toString().padStart(2, "0")}:${interval.minute
                    .toString()
                    .padStart(2, "0")}`}
                </div>
                {weekViewDates.map((date) => (
                  <div key={`${date.toDateString()}-${interval.hour}-${interval.minute}`}>
                    {renderTimeCell(date, interval)}
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderMonthView = () => {
    const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const daysInMonth = getDaysInMonth(currentDate);
    const startDayOfWeek = startOfMonth.getDay();
    const totalCells = Math.ceil((daysInMonth + startDayOfWeek) / 7) * 7;

    const monthDates = Array.from({ length: totalCells }, (_, i) => {
      const date = new Date(startOfMonth);
      date.setDate(1 - startDayOfWeek + i);
      return date;
    });

    return (
      <div className="grid grid-cols-7 gap-1">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <div key={day} className="font-medium text-center p-2">
            {day}
          </div>
        ))}
        {monthDates.map((date) => {
          const isCurrentMonth = date.getMonth() === currentDate.getMonth();
          const availableCount = countAvailableSlotsForDay(date, availableSlots, existingAppointments);

          return (
            <div
              key={date.toDateString()}
              className={`p-2 h-20 border rounded ${
                !isCurrentMonth
                  ? "bg-gray-50 text-gray-400"
                  : "bg-white text-gray-900"
              }`}
            >
              <div className="font-medium mb-1">{date.getDate()}</div>
              <div className="text-xs">
                {availableCount > 0 ? (
                  <span className="text-green-600">{availableCount} slots</span>
                ) : (
                  <span className="text-gray-400">No slots</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {showWarning && (
        <Alert className="border-yellow-200 bg-yellow-50">
          <AlertTriangle className="h-4 w-4 text-yellow-600" />
          <AlertTitle className="text-yellow-800">Insufficient Availability</AlertTitle>
          <AlertDescription className="text-yellow-700">
            You have only {totalAvailableSlots} available slots, but {requiredSlots} slots are required. 
            Please declare more slots of availability in the settings page.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between py-2">
        <div className="flex items-center space-x-1">
          <Button variant="outline" size="sm" onClick={navigatePrevious}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h3 className="text-base font-semibold px-2">
            {currentDate.toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            })}
          </h3>
          <Button variant="outline" size="sm" onClick={navigateNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="text-xs font-medium text-muted-foreground">
          Schedule Type: {scheduleType}
        </div>

        <div className="flex items-center space-x-1">
          <Button
            variant={view === "week" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("week")}
            className="px-3 py-1 text-xs"
          >
            Week
          </Button>
          <Button
            variant={view === "month" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("month")}
            className="px-3 py-1 text-xs"
          >
            Month
          </Button>
        </div>
      </div>

      {view === "week" ? renderWeekView() : renderMonthView()}

      <div className="flex items-center justify-between text-xs text-muted-foreground py-1">
        <div>
          Slots Selected: {selectedSlots.length}/{requiredSlots}
        </div>
        <div>
          Browser Timezone: {browserTimezone}
        </div>
      </div>
    </div>
  );
}
