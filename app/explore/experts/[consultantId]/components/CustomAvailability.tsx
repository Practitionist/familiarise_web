import React, { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { roundTime, timeToMinutes12h } from "../utils/time";
import {
  mergeConsecutiveSlotsForDisplay,
  overviewStatusKey,
} from "../utils/mergeSlots";
import type { PickerInterval } from "../types";
import { SLOT_STATUS_TOKENS } from "@/lib/scheduling/interval-status-tokens";
import { cn } from "@/utils/tailwind";

interface DayWithSlots {
  date: Date;
  slots: PickerInterval[];
}

interface CustomAvailabilityProps {
  days: DayWithSlots[];
  /** The display zone; booked dates are read in it. */
  zone: string;
  onPrevWeek?: () => void;
  onNextWeek?: () => void;
}

const VISIBLE_SLOT_COUNT = 5;

const shortDate = (date: Date) =>
  date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

const weekNavButton =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-card";

export const CustomAvailability: React.FC<CustomAvailabilityProps> = ({
  days,
  zone,
  onPrevWeek,
  onNextWeek,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Sort and merge consecutive slots for each day
  const mergedDays = useMemo(() => {
    return days.map((day) => {
      const sorted = day.slots.slice().sort((a, b) => {
        return (
          timeToMinutes12h(a.localStartTime) -
          timeToMinutes12h(b.localStartTime)
        );
      });
      return {
        ...day,
        slots: mergeConsecutiveSlotsForDisplay(sorted),
      };
    });
  }, [days]);

  // Check if any day has more slots than the visible limit
  const totalHidden = useMemo(() => {
    return mergedDays.reduce((sum, day) => {
      const excess = day.slots.length - VISIBLE_SLOT_COUNT;
      return sum + (excess > 0 ? excess : 0);
    }, 0);
  }, [mergedDays]);

  const weekIsEmpty = mergedDays.every((day) => day.slots.length === 0);
  const firstDay = mergedDays[0]?.date;
  const lastDay = mergedDays[mergedDays.length - 1]?.date;

  // The date of a booked time, read in the display zone.
  const getBookedSlotDate = (slot: PickerInterval) => {
    if (!slot.startsAt) return "";
    const date = new Date(slot.startsAt);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: zone,
    });
  };

  return (
    <section
      aria-label="Custom availability"
      className="rounded-2xl border border-border bg-card p-4 sm:p-6 md:p-8"
    >
      {/* The week and its arrows share one row, so the columns below keep the
          card's full width instead of losing it to two side buttons. */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Custom availability
          </p>
          {firstDay && lastDay && (
            <h3 className="text-lg font-semibold text-foreground">
              {shortDate(firstDay)} – {shortDate(lastDay)}
            </h3>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevWeek}
            disabled={!onPrevWeek}
            className={weekNavButton}
            aria-label="Previous week"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onNextWeek}
            disabled={!onNextWeek}
            className={weekNavButton}
            aria-label="Next week"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {weekIsEmpty ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No open times this week.
          {onNextWeek ? " Try the next week." : ""}
        </p>
      ) : (
        // One block per day: a row on phones (label left, times right) and a
        // column of the seven-day week from md up, so no width needs a sideways
        // scroll.
        <div className="space-y-3 md:grid md:grid-cols-7 md:gap-3 md:space-y-0">
          {mergedDays.map(({ date, slots: daySlots }) => {
            const visibleSlots = isExpanded
              ? daySlots
              : daySlots.slice(0, VISIBLE_SLOT_COUNT);

            return (
              <div key={date.toISOString()} className="flex gap-3 md:block">
                <div className="w-20 shrink-0 self-start rounded-lg bg-muted px-2 py-2 text-center md:mb-3 md:w-auto">
                  <div className="text-sm font-semibold text-foreground">
                    {date.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {shortDate(date)}
                  </div>
                </div>

                <div className="grid min-w-0 flex-1 grid-cols-2 content-start gap-2 md:block md:space-y-2">
                  {visibleSlots.length > 0 ? (
                    visibleSlots.map((slot) => {
                      const statusKey = overviewStatusKey(slot);
                      const isFullyBooked = statusKey === "fullyBooked";
                      const isPartiallyBooked = statusKey === "partiallyBooked";
                      const bookedDate =
                        isFullyBooked || isPartiallyBooked || slot.isAllocated
                          ? getBookedSlotDate(slot)
                          : "";

                      return (
                        <div
                          key={slot.id}
                          className={cn(
                            "relative flex min-h-[3.5rem] w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border px-1.5 py-2 text-xs",
                            SLOT_STATUS_TOKENS[statusKey].className,
                          )}
                        >
                          {/* Wraps only between start and end, never inside a time. */}
                          <div className="flex flex-wrap justify-center gap-x-1 text-center text-[11px] font-medium leading-tight">
                            <span className="whitespace-nowrap">
                              {roundTime(slot.localStartTime)}
                            </span>
                            <span className="whitespace-nowrap">
                              – {roundTime(slot.localEndTime)}
                            </span>
                          </div>

                          {/* Status and date for booked/allocated slots */}
                          {isFullyBooked && (
                            <div className="text-center text-[10px] font-semibold leading-tight opacity-90">
                              Booked
                              <br />
                              {bookedDate && `(${bookedDate})`}
                            </div>
                          )}
                          {isPartiallyBooked && (
                            <div className="text-center text-[10px] font-semibold leading-tight opacity-90">
                              Partially
                              <br />
                              Booked {bookedDate && `(${bookedDate})`}
                            </div>
                          )}
                          {slot.isAllocated && statusKey === "available" && (
                            <div className="text-center text-[10px] font-semibold leading-tight opacity-90">
                              Request
                              <br />
                              Approval {bookedDate && `(${bookedDate})`}
                            </div>
                          )}
                          {(statusKey === "tooSoon" ||
                            statusKey === "limitReached") && (
                            <div className="text-center text-[10px] font-semibold leading-tight opacity-90">
                              {SLOT_STATUS_TOKENS[statusKey].label}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    // Quiet text, not a box: five empty boxes in a row
                    // outweighed the one open slot beside them.
                    <div className="col-span-2 flex min-h-[3.25rem] items-center text-sm text-muted-foreground/60 md:min-h-[3.5rem] md:justify-center">
                      <span className="text-xs md:sr-only">No times</span>
                      <span aria-hidden="true" className="hidden md:inline">
                        –
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Single expand/collapse button for the entire week */}
      {!weekIsEmpty && totalHidden > 0 && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                Show {totalHidden} more times
              </>
            )}
          </button>
        </div>
      )}
    </section>
  );
};
