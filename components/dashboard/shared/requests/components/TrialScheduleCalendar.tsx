"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { TIntervalTiming } from "@/types/slots";
import {
  breakDownSlotsByDuration,
  mergeConsecutiveSlots,
} from "@/utils/scheduling-engine/intervals";
import { useToast } from "@/hooks/use-toast";
import { format as formatTz } from "date-fns-tz";
import { Calendar, Clock, Loader2, Check } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { Badge } from "@/components/ui/badge";

export interface SelectedSlot {
  startsAt: Date;
  endsAt: Date;
  availabilityWindowId: string;
  slotType: "WEEKLY" | "CUSTOM";
}

// Slot status types for visual representation
type SlotStatus = "available" | "partial" | "booked" | "selected";

// Color classes for different slot states
const slotColorClasses: Record<SlotStatus, string> = {
  available: "bg-green-100 hover:bg-green-200 text-green-800 border-green-400",
  partial:
    "bg-yellow-100 hover:bg-yellow-200 text-yellow-800 border-yellow-400",
  booked: "bg-red-100 text-red-600 cursor-not-allowed border-red-400",
  selected: "bg-primary hover:bg-gray-800 text-white border-gray-900",
};

// Determine slot status based on allocation
function getSlotStatus(slot: TIntervalTiming, isSelected: boolean): SlotStatus {
  if (isSelected) return "selected";
  if (slot.isAllocated) return "booked";
  // Note: partiallyBooked can be added to TIntervalTiming type if needed in future
  return "available";
}

interface TrialScheduleCalendarProps {
  consultantId: string;
  trialDurationMinutes: number;
  onSlotSelect: (slot: SelectedSlot) => void;
  onCancel: () => void;
  isProcessing?: boolean;
  consulteeUserName?: string;
}

export function TrialScheduleCalendar({
  consultantId,
  trialDurationMinutes,
  onSlotSelect,
  onCancel,
  isProcessing = false,
  consulteeUserName,
}: TrialScheduleCalendarProps) {
  const { toast } = useToast();
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [currentDate, setCurrentDate] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [slotTimings, setSlotTimings] = useState<TIntervalTiming[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TIntervalTiming | null>(
    null,
  );
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);

  const durationInHours = trialDurationMinutes / 60;

  // Fetch availability slots when date changes
  useEffect(() => {
    async function fetchSlots() {
      if (!selectedDate || !consultantId || !timezone) {
        setSlotTimings([]);
        return;
      }

      setIsLoadingSlots(true);
      try {
        const startDateInUtc = new Date(selectedDate);
        startDateInUtc.setHours(0, 0, 0, 0);
        const endDateInUtc = new Date(selectedDate);
        endDateInUtc.setHours(23, 59, 59, 999);

        const response = await fetch(
          `/api/scheduling/availability-with-allocation/${consultantId}?` +
            `startDateInUtc=${startDateInUtc.toISOString()}&` +
            `endDateInUtc=${endDateInUtc.toISOString()}&` +
            `timezone=${timezone}`,
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.error || "Failed to fetch availability slots",
          );
        }

        const { data } = await response.json();
        const selectedDateKey = formatTz(selectedDate, "yyyy-MM-dd", {
          timeZone: timezone,
        });
        const slotsForSelectedDate = data[selectedDateKey] || [];
        setSlotTimings(slotsForSelectedDate);
      } catch (error) {
        console.error("Error fetching slots:", error);
        toast({
          title: "Error fetching availability",
          description:
            error instanceof Error ? error.message : "Please try again",
          variant: "destructive",
        });
        setSlotTimings([]);
      } finally {
        setIsLoadingSlots(false);
      }
    }

    fetchSlots();
  }, [selectedDate, consultantId, timezone, toast]);

  // Filter slots by trial duration
  const availableSlots = useMemo(() => {
    if (
      !slotTimings ||
      slotTimings.length === 0 ||
      !timezone ||
      !selectedDate
    ) {
      return [];
    }

    const slotsWithAllocation = slotTimings.map((slot) => ({
      ...slot,
      isAllocated: slot.isAllocated || false,
    }));

    // Merge consecutive available slots into contiguous blocks
    // This allows longer durations (45min, 60min) to be scheduled across multiple adjacent 30-min slots
    const mergedSlots = mergeConsecutiveSlots(slotsWithAllocation);

    const brokenDownSlots = breakDownSlotsByDuration(
      mergedSlots,
      durationInHours,
      [],
      timezone,
    );

    // Filter out slots in the past AND allocated slots
    const now = new Date();
    return brokenDownSlots.filter((slot) => {
      const slotStart = new Date(slot.startsAt);
      // Exclude past slots and allocated (booked) slots
      return slotStart > now && !slot.isAllocated;
    });
  }, [slotTimings, durationInHours, timezone, selectedDate]);

  // Render calendar days
  const renderCalendar = useCallback(() => {
    const daysInMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() + 1,
      0,
    ).getDate();
    const firstDayOfMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      1,
    ).getDay();

    const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Empty cells for days before the first day of month
    for (let i = 0; i < adjustedFirstDay; i++) {
      days.push(<div key={`empty-${i}`} className="h-10 w-full" />);
    }

    // Day cells
    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      const isSelected =
        selectedDate?.getDate() === i &&
        selectedDate?.getMonth() === currentDate.getMonth() &&
        selectedDate?.getFullYear() === currentDate.getFullYear();
      const isPast = date < today;

      days.push(
        <button
          key={i}
          type="button"
          aria-pressed={isSelected}
          aria-label={date.toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          disabled={isPast}
          className={`w-full h-10 rounded-xl text-base font-medium transition-all duration-200 flex items-center justify-center
            ${
              isSelected
                ? "bg-primary text-white shadow-md"
                : isPast
                  ? "text-gray-300 cursor-not-allowed"
                  : "text-foreground hover:bg-accent"
            }`}
          onClick={() => {
            if (!isPast) {
              setSelectedDate(date);
              setSelectedSlot(null);
            }
          }}
        >
          {i}
        </button>,
      );
    }

    return days;
  }, [currentDate, selectedDate]);

  const handleConfirm = () => {
    if (!selectedSlot) {
      toast({
        title: "Please select a time slot",
        variant: "destructive",
      });
      return;
    }

    onSlotSelect({
      startsAt: new Date(selectedSlot.startsAt),
      endsAt: new Date(selectedSlot.endsAt),
      availabilityWindowId: selectedSlot.availabilityWindowId,
      slotType: selectedSlot.type,
    });
  };

  return (
    <div className="calendar-surface space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <h2 className="text-xl font-semibold text-foreground">
          Schedule Trial
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {consulteeUserName
            ? `Select a ${trialDurationMinutes}-minute slot for the trial session with ${consulteeUserName}`
            : `Select a ${trialDurationMinutes}-minute slot for the trial session`}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
        {/* Calendar Section */}
        <div>
          <h3 className="text-base font-medium mb-4 flex items-center text-foreground">
            <Calendar className="mr-2 h-5 w-5 text-muted-foreground" />
            Select a Date
          </h3>
          <div className="bg-muted/50 p-4 lg:p-5 rounded-xl border border-border">
            {/* Month Navigation */}
            <div className="flex justify-between items-center mb-4">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Previous month"
                className="text-muted-foreground hover:text-foreground hover:bg-accent h-9 w-9"
                onClick={() =>
                  setCurrentDate(
                    new Date(
                      currentDate.getFullYear(),
                      currentDate.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                &lt;
              </Button>
              <span className="font-semibold text-foreground">
                {currentDate.toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Next month"
                className="text-muted-foreground hover:text-foreground hover:bg-accent h-9 w-9"
                onClick={() =>
                  setCurrentDate(
                    new Date(
                      currentDate.getFullYear(),
                      currentDate.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                &gt;
              </Button>
            </div>

            {/* Weekday Headers */}
            <div className="grid grid-cols-7 gap-2 text-center text-sm font-medium text-muted-foreground mb-2">
              <div>Mo</div>
              <div>Tu</div>
              <div>We</div>
              <div>Th</div>
              <div>Fr</div>
              <div>Sa</div>
              <div>Su</div>
            </div>

            {/* Calendar Days */}
            <div className="grid grid-cols-7 gap-1">{renderCalendar()}</div>
          </div>
        </div>

        {/* Slots Section */}
        <div>
          <h3 className="text-base font-medium mb-4 flex items-center text-foreground">
            <Clock className="mr-2 h-5 w-5 text-muted-foreground" />
            Available {trialDurationMinutes}-min Slots
          </h3>

          <div className="bg-muted/50 p-4 rounded-xl border border-border min-h-[280px] max-h-[350px] overflow-y-auto">
            {isLoadingSlots ? (
              <div className="flex items-center justify-center h-full py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                <span className="ml-2 text-muted-foreground">
                  Loading slots...
                </span>
              </div>
            ) : availableSlots.length > 0 ? (
              <>
                <div className="space-y-2">
                  {availableSlots.map((slot, index) => {
                    const isSelected =
                      selectedSlot?.slotId === slot.slotId &&
                      selectedSlot?.localStartTime === slot.localStartTime;
                    const slotStatus = getSlotStatus(slot, isSelected);
                    const isDisabled = slotStatus === "booked";

                    return (
                      <button
                        key={`${slot.slotId}-${index}`}
                        disabled={isDisabled}
                        className={cn(
                          "w-full p-3 text-sm font-medium transition-all duration-200 rounded-lg text-left border",
                          slotColorClasses[slotStatus],
                          isSelected && "ring-2 ring-gray-900 ring-offset-1",
                        )}
                        onClick={() => !isDisabled && setSelectedSlot(slot)}
                      >
                        <div className="flex items-center justify-between w-full">
                          <div className="flex items-center">
                            <Clock
                              className={cn(
                                "mr-2 h-4 w-4",
                                isSelected
                                  ? "text-white"
                                  : "text-current opacity-60",
                              )}
                            />
                            <span>
                              {slot.localStartTime} - {slot.localEndTime}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            {slotStatus === "booked" && (
                              <Badge
                                variant="secondary"
                                className="text-xs bg-gray-200 text-muted-foreground"
                              >
                                Booked
                              </Badge>
                            )}
                            {slotStatus === "partial" && (
                              <Badge
                                variant="outline"
                                className="text-xs bg-amber-50 text-amber-700 border-amber-300"
                              >
                                Partial
                              </Badge>
                            )}
                            {isSelected && (
                              <Check className="h-4 w-4 text-white" />
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Legend */}
                <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-border text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-green-200 border border-green-500" />
                    <span>Available</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-yellow-200 border border-yellow-500" />
                    <span>Partial</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-red-200 border border-red-500" />
                    <span>Booked</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded bg-primary border border-gray-900" />
                    <span>Selected</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full py-8 text-center">
                <Clock className="h-10 w-10 text-gray-300 mb-3" />
                <p className="text-muted-foreground text-sm">
                  No available slots for this date.
                </p>
                <p className="text-gray-400 text-xs mt-1">
                  Try selecting a different date.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Trial Info */}
      <div className="bg-gray-100 border border-gray-300 rounded-lg p-3">
        <p className="text-sm text-gray-800">
          <span className="font-medium">Duration:</span> {trialDurationMinutes}{" "}
          minutes
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Timezone: {timezone}
        </p>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-2 border-t border-border">
        <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={!selectedSlot || isProcessing}
          className="bg-primary hover:bg-gray-800 text-white"
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Scheduling...
            </>
          ) : (
            "Confirm Schedule"
          )}
        </Button>
      </div>
    </div>
  );
}
