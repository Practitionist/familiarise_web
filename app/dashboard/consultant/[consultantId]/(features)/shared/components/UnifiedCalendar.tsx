"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DAYS,
  INTERVALS,
} from "@/utils/timeSlotsMeta";
import { format, addDays, startOfWeek, isSameDay } from "date-fns";
import { ChevronLeft, ChevronRight, Calendar, Clock, Users, Zap, RotateCcw } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { TimeSlot, AppointmentDetail } from "../utils/calendarUtils";
import { useCalendarData } from "../hooks/useCalendarData";
import { useSlotAllocation } from "../hooks/useSlotAllocation";
import { 
  fetchSessionDurationFromPlan, 
  groupConsecutiveSlots, 
  validateElongatedSlotSelection,
  getElongatedSlotStyling,
  convertElongatedSlotsTo30MinSlots 
} from "../utils/elongatedSlots";

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
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  const [actualSessionDuration, setActualSessionDuration] = useState<number>(sessionDurationInHours || 1);
  const [elongatedSlotGroups, setElongatedSlotGroups] = useState<TimeSlot[][]>([]);

  // Initialize timezone
  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // Fetch session duration from plan if not provided
  useEffect(() => {
    const fetchDuration = async () => {
      if (sessionDurationInHours) {
        setActualSessionDuration(sessionDurationInHours);
        return;
      }

      if (eventId) {
        try {
          const duration = await fetchSessionDurationFromPlan(eventType, eventId);
          setActualSessionDuration(duration);
        } catch (error) {
          console.error("Failed to fetch session duration:", error);
          // For now, use a default value instead of throwing to prevent calendar crashes
          console.warn(`Using default 1-hour duration for ${eventType} due to fetch error`);
          setActualSessionDuration(1);
        }
      } else if (mode !== "view") {
        // Only require eventId for non-view modes
        console.warn(`No eventId provided for ${eventType} calendar in ${mode} mode. Using default 1-hour duration.`);
        setActualSessionDuration(1);
      } else {
        // View mode doesn't need duration
        setActualSessionDuration(1);
      }
    };

    fetchDuration();
  }, [eventType, eventId, sessionDurationInHours, mode]);

  // Calendar data hook
  const {
    consultantDetails,
    availableSlots,
    existingAppointments,
    eventSlots,
    loading,
    error,
    refetch,
    getSlotStatusForInterval,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
  });

  // Slot allocation hook
  const {
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    requiredSlots,
    canAllocate,
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
  }, [preSelectedSlots]); // Remove setSelectedSlots to prevent infinite loops

  // Update elongated slot groups when selected slots change
  useEffect(() => {
    if (selectedSlots.length > 0) {
      const groups = groupConsecutiveSlots(selectedSlots);
      setElongatedSlotGroups(groups);
    } else {
      setElongatedSlotGroups([]);
    }
  }, [selectedSlots]);

  // Call onSlotsSelected when selection changes
  useEffect(() => {
    if (mode === "select" && onSlotsSelected) {
      onSlotsSelected(selectedSlots);
    }
  }, [selectedSlots, mode]); // Remove onSlotsSelected from dependencies to prevent infinite loops

  // Custom allocation handler that validates elongated slots
  const handleElongatedSlotAllocation = async () => {
    // Validate that selected slots form valid elongated sessions
    const validation = validateElongatedSlotSelection(
      selectedSlots,
      actualSessionDuration,
      false // Don't allow partial sessions
    );

    if (!validation.isValid) {
      // Show error message
      console.error("Invalid slot selection:", validation.errorMessage);
      return;
    }

    // Convert elongated slots to 30-minute API format
    const apiSlots = convertElongatedSlotsTo30MinSlots(validation.validGroups.flat());
    
    // Call the original manual allocate with converted slots
    try {
      await manualAllocate();
    } catch (error) {
      console.error("Allocation failed:", error);
    }
  };

  // Week view dates
  const weekDates = useMemo(() => {
    const startDate = startOfWeek(currentDate);
    return [...Array(7)].map((_, i) => addDays(startDate, i));
  }, [currentDate]);

  // Navigation handlers
  const navigatePrevious = () => {
    if (view === "week") {
      const newDate = new Date(currentDate);
      newDate.setDate(newDate.getDate() - 7);
      setCurrentDate(newDate);
    } else {
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() - 1);
      setCurrentDate(newDate);
    }
  };

  const navigateNext = () => {
    if (view === "week") {
      const newDate = new Date(currentDate);
      newDate.setDate(newDate.getDate() + 7);
      setCurrentDate(newDate);
    } else {
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() + 1);
      setCurrentDate(newDate);
    }
  };

  // Handle slot click
  const handleSlotClick = (
    interval: { hour: number; minute: number },
    date: Date,
  ) => {
    if (mode === "view") return;

    const status = getSlotStatusForInterval(interval, date);
    if (status.isDisabled) return;

    // Create 30-minute slot (elongation is handled visually)
    const slot: TimeSlot = {
      startTime: new Date(status.intervalStartUTCString),
      endTime: new Date(status.intervalEndUTCString), // Keep 30-minute slots
      isAvailable: status.isAvailable,
      isBooked: status.isBooked,
    };

    if (mode === "select" || mode === "allocate") {
      toggleSlot(slot);
    }
  };

  // Render time cell
  const renderTimeCell = (
    interval: { hour: number; minute: number },
    date: Date,
  ) => {
    const status = getSlotStatusForInterval(interval, date);
    const slotUTCTimestamp = status.intervalStartUTCString;
    
    const slot: TimeSlot = {
      startTime: new Date(status.intervalStartUTCString),
      endTime: new Date(status.intervalEndUTCString),
      isAvailable: status.isAvailable,
      isBooked: status.isBooked,
    };

    const isCurrentlySelected = isSlotSelected(slot);
    const isEventSlot = eventSlots.some(es => 
      es.startTime.getTime() === slot.startTime.getTime()
    );

    // Find if this slot is part of an elongated group and get its position
    let elongatedSlotInfo: { groupIndex: number; slotIndex: number; groupSize: number } | null = null;
    if (isCurrentlySelected) {
      for (let groupIndex = 0; groupIndex < elongatedSlotGroups.length; groupIndex++) {
        const group = elongatedSlotGroups[groupIndex];
        const slotIndex = group.findIndex(s => s.startTime.getTime() === slot.startTime.getTime());
        if (slotIndex !== -1) {
          elongatedSlotInfo = { groupIndex, slotIndex, groupSize: group.length };
          break;
        }
      }
    }

    let cellClassName = "h-8 w-full relative transition-colors duration-150 ease-in-out border border-transparent rounded-sm text-[10px] leading-tight px-1 py-0.5";
    let buttonText = "";
    const showTooltip = (status.isBooked || status.isPartiallyBooked || status.isConflicting) && status.overlappingAppointments.length > 0;

    if (isCurrentlySelected) {
      cellClassName += " bg-primary text-primary-foreground hover:bg-primary/90 border-primary-darker";
      
      // Apply elongated slot styling
      if (elongatedSlotInfo) {
        const styling = getElongatedSlotStyling(elongatedSlotInfo.slotIndex, elongatedSlotInfo.groupSize);
        cellClassName = cellClassName.replace("rounded-sm", ""); // Remove default rounding
        cellClassName += ` border-2`; // Stronger border for grouped slots
        
        // Apply custom border radius based on position in group
        const borderRadiusClass = styling.borderRadius === "4px" ? "rounded-sm" :
          styling.borderRadius === "4px 4px 0 0" ? "rounded-t-sm" :
          styling.borderRadius === "0 0 4px 4px" ? "rounded-b-sm" : "";
        cellClassName += ` ${borderRadiusClass}`;
      }
      
      // Show group number for better visual grouping
      if (elongatedSlotInfo) {
        const requiredSlotsPerSession = Math.ceil(actualSessionDuration * 2);
        const isComplete = elongatedSlotInfo.groupSize >= requiredSlotsPerSession;
        buttonText = `Session ${elongatedSlotInfo.groupIndex + 1}${isComplete ? '' : '*'}`;
      } else {
        buttonText = "Selected";
      }
    } else if (isEventSlot) {
      cellClassName += " bg-blue-500 text-white border-blue-600";
      buttonText = "Scheduled";
    } else if (status.isBooked) {
      cellClassName += " bg-slate-400 text-slate-800 cursor-not-allowed";
      cellClassName += status.isInPast ? " opacity-50" : "";
      buttonText = "Booked";
    } else if (status.isPartiallyBooked) {
      cellClassName += " bg-yellow-400 text-yellow-900 cursor-not-allowed";
      cellClassName += status.isInPast ? " opacity-50" : "";
      buttonText = "Partially Booked";
    } else if (status.isConflicting) {
      cellClassName += " bg-red-400 text-red-900 cursor-not-allowed";
      buttonText = "Conflicting";
    } else if (status.isAvailable) {
      if (status.isInPast) {
        cellClassName += " bg-green-300 text-green-950 opacity-50 cursor-not-allowed border-green-400";
        buttonText = "Available";
      } else {
        cellClassName += " bg-green-300 text-green-950 hover:bg-green-400 border-green-400";
        buttonText = "Available";
      }
    } else {
      if (status.isInPast) {
        cellClassName += " bg-gray-300 text-gray-700 cursor-not-allowed opacity-70";
      } else {
        cellClassName += " bg-slate-200 cursor-not-allowed";
      }
    }

    const isButtonDisabled = status.isDisabled && !isCurrentlySelected && mode !== "view";

    const buttonElement = (
      <Button
        key={slotUTCTimestamp}
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
                {status.overlappingAppointments.map((appSlot: AppointmentDetail, index: number) => (
                  <div
                    key={`${appSlot.id}-${index}`}
                    className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                  >
                    <p className="font-semibold">{appSlot.title}</p>
                    <p className="text-muted-foreground">{appSlot.type}</p>
                    {appSlot.with && (
                      <p className="text-muted-foreground">with {appSlot.with}</p>
                    )}
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

  // Render month view
  const renderMonthView = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);

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
            const availableCount = isPastDay ? 0 : countAvailableSlotsForDay(date);

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
  };

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
          <Button variant="outline" size="sm" onClick={navigatePrevious}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-lg font-bold text-center min-w-[150px]">
            {view === "week"
              ? `${format(weekDates[0], "MMM d")} - ${format(weekDates[6], "MMM d, yyyy")}`
              : format(currentDate, "MMMM yyyy")}
          </div>
          <Button variant="outline" size="sm" onClick={navigateNext}>
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
          <div className="flex-1 overflow-y-auto scrollbar-thin">
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
                      timeZone: browserTimezone,
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
              const requiredSlotsPerSession = Math.ceil(actualSessionDuration * 2); // 30-min slots needed
              const completeSessions = elongatedSlotGroups.filter(group => group.length >= requiredSlotsPerSession).length;
              const totalSessions = elongatedSlotGroups.length;
              
              if (selectedSlots.length === 0) {
                return "No slots selected";
              }
              
              return `Selected: ${selectedSlots.length} slots forming ${totalSessions} session${totalSessions !== 1 ? 's' : ''} (${completeSessions} complete)`;
            })()}
          </div>
          <div className="text-xs text-muted-foreground">
            Required: {actualSessionDuration}h per session ({Math.ceil(actualSessionDuration * 2)} consecutive slots)
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
              onClick={handleElongatedSlotAllocation}
              disabled={!canAllocate || isAllocating}
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