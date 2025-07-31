"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DAYS, INTERVALS } from "@/utils/timeSlotsMeta";
import {
  format,
  addDays,
  startOfWeek,
  endOfWeek,
  isSameDay,
  subDays,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  Users,
  Zap,
  RotateCcw,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback } from "react";
import {
  TimeSlot,
  AppointmentDetail,
  calculateRequiredSlots,
} from "../utils/calendarUtils";
import { useCalendarData } from "../hooks/useCalendarData";
import { useSlotAllocation } from "../hooks/useSlotAllocation";
import { cn } from "@/utils/tailwind";

export interface UnifiedCalendarProps {
  consultantId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  durationInMonths?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number; // Optional - will be fetched from plan if not provided
  mode: "view" | "select" | "allocate";
  onSlotsSelected?: (slots: TimeSlot[]) => void;
  onAllocationComplete?: (result: any) => void;
  showAllocationButtons?: boolean;
  preSelectedSlots?: TimeSlot[];
  requestedSlots?: TimeSlot[];
  className?: string;
}

export function UnifiedCalendar({
  consultantId,
  eventType,
  sessionDurationInHours,
  eventId,
  durationInMonths,
  callsPerWeek,
  mode = "view",
  onSlotsSelected,
  onAllocationComplete,
  showAllocationButtons = false,
  preSelectedSlots = [],
  requestedSlots = [],
  className = "",
}: UnifiedCalendarProps) {
  // State
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");

  // Initialize timezone
  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // Use calendar data hook
  const {
    consultantDetails,
    availableSlots,
    existingAppointments,
    loading,
    error,
    refetch,
    getSlotStatusForInterval,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
  });

  // Slot allocation hook
  const {
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    toggleSlot,
    clearSlots,
    isSlotSelected,
    manualAllocate,
    autoAllocate,
    preAllocate,
  } = useSlotAllocation({
    eventType,
    eventId: eventId || "",
    durationInMonths,
    callsPerWeek,
    onSuccess: onAllocationComplete,
  });

  // Initialize pre-selected slots
  useEffect(() => {
    if (preSelectedSlots.length > 0) {
      setSelectedSlots(preSelectedSlots);
    }
  }, [preSelectedSlots, setSelectedSlots]);

  // Call onSlotsSelected when selection changes
  useEffect(() => {
    if (mode === "select" && onSlotsSelected) {
      onSlotsSelected(selectedSlots);
    }
  }, [selectedSlots, mode, onSlotsSelected]);

  // Week view dates
  const weekDates = useMemo(() => {
    const startDate = startOfWeek(currentDate);
    return [...Array(7)].map((_, i) => addDays(startDate, i));
  }, [currentDate]);

  // Handle slot click
  const handleSlotClick = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      if (mode === "view") return;

      const status = getSlotStatusForInterval(interval, date);
      if (status.isDisabled) return;

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      if (mode === "select" || mode === "allocate") {
        toggleSlot(slot);
      }
    },
    [mode, getSlotStatusForInterval, toggleSlot],
  );

  // Render time cell
  const renderTimeCell = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      const status = getSlotStatusForInterval(interval, date);

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      const isCurrentlySelected = isSlotSelected(slot);

      // Fast-exit: avoid rendering a clickable button for cells that have no
      // availability **and** are disabled (e.g. past date).  Rendering a
      // lightweight placeholder saves performance.
      if (!status.isAvailable && !status.isBooked && status.isInPast) {
        return (
          <div className="h-8 w-full bg-gray-100 border border-gray-200 rounded-sm" />
        );
      }

      let cellClassName =
        "h-8 w-full relative transition-colors duration-150 ease-in-out border border-transparent rounded-sm text-[10px] leading-tight px-1 py-0.5";
      let buttonText = "";
      const showTooltip =
        (status.isBookedForDisplay || status.isPartiallyBooked) &&
        status.overlappingAppointments.length > 0;

      if (isCurrentlySelected) {
        cellClassName +=
          " bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
        buttonText = "Selected";
      } else if (status.isBookedForDisplay) {
        cellClassName += " bg-slate-400 text-slate-800 cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Booked";
      } else if (status.isPartiallyBooked) {
        cellClassName += " bg-yellow-400 text-yellow-900 cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = "Partially Booked";
      } else if (status.isAvailable) {
        if (status.isInPast) {
          cellClassName +=
            " bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
          buttonText = "Available";
        } else {
          cellClassName +=
            " bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
          buttonText = "Available";
        }
      } else {
        if (status.isInPast) {
          cellClassName +=
            " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
        } else {
          cellClassName += " bg-slate-200 cursor-not-allowed";
        }
      }

      const isButtonDisabled =
        status.isDisabled && !isCurrentlySelected && mode !== "view";

      const buttonElement = (
        <Button
          variant="ghost"
          className={cellClassName}
          onClick={() => handleSlotClick(interval, date)}
          disabled={isButtonDisabled}
        >
          {buttonText}
        </Button>
      );

      if (showTooltip) {
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>{buttonElement}</TooltipTrigger>
              <TooltipContent
                className="max-w-xs text-xs"
                side="top"
                align="center"
              >
                <div className="flex flex-col gap-1">
                  {status.overlappingAppointments.map(
                    (appSlot: AppointmentDetail, index: number) => (
                      <div
                        key={`${appSlot.id}-${index}`}
                        className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                      >
                        <p className="font-semibold">{appSlot.title}</p>
                        <p className="text-muted-foreground">{appSlot.type}</p>
                        {appSlot.with && (
                          <p className="text-muted-foreground">
                            with {appSlot.with}
                          </p>
                        )}
                      </div>
                    ),
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      }

      return buttonElement;
    },
    [
      getSlotStatusForInterval,
      isSlotSelected,
      handleSlotClick,
      availableSlots,
      consultantDetails,
      loading,
      error,
      mode,
    ],
  );

  // Render month view
  const renderMonthView = useCallback(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      for (const interval of INTERVALS) {
        const status = getSlotStatusForInterval(interval, date);
        if (status.isAvailable && !status.isInPast) {
          count++;
        }
      }
      return count;
    };

    return (
      <div className="grid grid-cols-7 gap-1 h-[600px] overflow-y-auto">
        {DAYS.map((day) => (
          <div key={day} className="text-center font-bold p-2">
            {day.slice(0, 3)}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div
            key={`empty-start-${i}`}
            className="min-h-[100px] border bg-gray-50/50"
          />
        ))}
        {Array.from(
          { length: new Date(year, month + 1, 0).getDate() },
          (_, i) => {
            const date = new Date(year, month, i + 1);
            const isCurrentDay = isSameDay(date, now);
            const isPastDay = date < today;
            const availableCount = isPastDay
              ? 0
              : countAvailableSlotsForDay(date);

            return (
              <div
                key={date.toISOString()}
                className={`min-h-[100px] border p-1 flex flex-col ${
                  isCurrentDay ? "ring-2 ring-primary" : ""
                } ${isPastDay ? "bg-gray-100 text-gray-400" : "bg-white"}`}
              >
                <div
                  className={`font-bold mb-1 text-xs ${
                    isCurrentDay ? "text-primary" : ""
                  } ${isPastDay ? "" : "text-gray-700"}`}
                >
                  {i + 1}
                </div>
                <div className="flex-grow flex items-center justify-center">
                  {!isPastDay && availableCount > 0 && (
                    <Badge variant="outline" className="text-[10px] p-1">
                      {availableCount} slots
                    </Badge>
                  )}
                  {!isPastDay && availableCount === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No Slots
                    </span>
                  )}
                </div>
              </div>
            );
          },
        )}
      </div>
    );
  }, [currentDate, getSlotStatusForInterval]);

  // Loading state
  if (loading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
        <span className="ml-2">Loading calendar...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={`bg-red-50 p-4 rounded-md text-red-700 ${className}`}>
        <p>Error loading calendar: {error}</p>
        <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
          <RotateCcw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // No consultant data
  if (!consultantDetails) {
    return (
      <div className={`text-center p-8 text-muted-foreground ${className}`}>
        <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No calendar data available</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {/* Header */}
      <div className="flex justify-between items-center gap-4">
        <div className="flex gap-2">
          <Button
            variant={view === "week" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("week")}
          >
            Week
          </Button>
          <Button
            variant={view === "month" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("month")}
          >
            Month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? subWeeks(currentDate, 1)
                  : subMonths(currentDate, 1),
              )
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-lg font-bold text-center min-w-[150px]">
            {view === "week"
              ? `${format(startOfWeek(currentDate), "MMM d")} - ${format(endOfWeek(currentDate), "MMM d, yyyy")}`
              : format(currentDate, "MMMM yyyy")}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? addWeeks(currentDate, 1)
                  : addMonths(currentDate, 1),
              )
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="w-20"></div>
      </div>

      {/* Allocation buttons */}
      {showAllocationButtons && mode === "allocate" && (
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => autoAllocate(availableSlots)}
            disabled={isAllocating}
          >
            <Zap className="h-4 w-4 mr-2" />
            Auto Allocate
          </Button>

          {requestedSlots.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => preAllocate(requestedSlots)}
              disabled={isAllocating}
            >
              <Clock className="h-4 w-4 mr-2" />
              Use Requested Times
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={clearSlots}
            disabled={isAllocating || selectedSlots.length === 0}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Clear Selection
          </Button>
        </div>
      )}

      {/* Calendar View */}
      {view === "week" ? (
        <div className="flex flex-col h-[calc(100vh-20rem)] md:h-[65vh] max-h-[700px]">
          {/* Week header */}
          <div className="grid grid-cols-8 gap-0.5 md:gap-1 sticky top-0 bg-background z-20 pb-1">
            <div className="w-14 md:w-20"></div>
            {weekDates.map((date, index) => {
              const isToday = isSameDay(date, new Date());
              return (
                <div key={DAYS[index]} className="text-center p-1 md:p-2">
                  <div
                    className={`font-bold text-xs md:text-base ${
                      isToday ? "text-primary" : ""
                    }`}
                  >
                    {DAYS[index].slice(0, 3)}
                  </div>
                  <div className="text-xs md:text-sm text-muted-foreground">
                    {format(date, "d")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Week grid */}
          <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
            {INTERVALS.map((interval, i) => (
              <div
                key={`interval-row-${interval.hour}-${interval.minute}`}
                className="grid grid-cols-8 gap-0.5 md:gap-1"
              >
                <div className="w-14 md:w-20">
                  <div className="h-8 text-right pr-2 pt-0.5 text-[10px] md:text-sm flex items-start justify-end">
                    {new Date(
                      1970,
                      0,
                      1,
                      interval.hour,
                      interval.minute,
                    ).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </div>
                </div>
                {weekDates.map((date) => (
                  <div key={date.toISOString()} className="col-span-1">
                    {renderTimeCell(interval, date)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        renderMonthView()
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="text-sm">
            {(() => {
              try {
                const requiredSlotsForThisEvent = calculateRequiredSlots(
                  eventType,
                  durationInMonths,
                  callsPerWeek,
                  sessionDurationInHours,
                );

                if (selectedSlots.length === 0) {
                  return `0 selected out of ${requiredSlotsForThisEvent} required slots for the session`;
                }

                return `${selectedSlots.length} selected out of ${requiredSlotsForThisEvent} required slots for the session`;
              } catch (error) {
                console.error("Error calculating footer stats:", error);
                return `Selected: ${selectedSlots.length} slots`;
              }
            })()}
          </div>
          <div className="text-xs text-muted-foreground">
            Required: {sessionDurationInHours || 1}h per session (
            {Math.ceil((sessionDurationInHours || 1) * 2)} consecutive slots)
          </div>
          {allocationError && (
            <div className="text-sm text-red-600">{allocationError}</div>
          )}
        </div>

        <div className="text-sm text-muted-foreground">
          Timezone: {browserTimezone}
        </div>

        {mode === "allocate" && (
          <div className="flex gap-2">
            <Button
              onClick={() => manualAllocate()}
              disabled={isAllocating}
              size="sm"
            >
              <Users className="h-4 w-4 mr-2" />
              {isAllocating ? "Allocating..." : "Allocate Selected"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
