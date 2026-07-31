"use client";

import { UnifiedCalendar, UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";
import { SlotStatusLegend } from "./SlotStatusLegend";
import {
  BUYER_LEGEND_KEYS,
  CONSULTANT_LEGEND_KEYS,
} from "@/lib/scheduling/slot-status-tokens";
import { cn } from "@/utils/tailwind";

/**
 * Mounts the legend alongside the calendar.
 *
 * The grid has always coloured cells in seven distinct states and never said
 * what any of them meant, so a consultant seeing a yellow cell had to guess
 * whether it was bookable. Putting the legend here rather than inside
 * UnifiedCalendar means every caller gets it and none can forget it.
 */
export function SafeUnifiedCalendar({
  className,
  ...props
}: UnifiedCalendarProps) {
  return (
    <CalendarErrorBoundary>
      {/* The caller's layout classes go on the WRAPPER, not the calendar: this
          div is what their flex parent measures now, so leaving `min-h-0
          flex-1` on the inner element sized a child of a plain block box and
          the calendar stopped filling its dialog. */}
      <div className={cn("flex min-h-0 flex-col gap-3", className)}>
        {/* Above the grid, not below: a key you can only reach by scrolling
            past the thing it explains is backwards, and on a laptop it sat
            below the fold entirely (#1064). A buyer picking a time has no use
            for "This booking" or "Being moved" — those name states of an
            allocation they are not doing, and one of them refers to a slot
            the picker does not even display. Follows `mode` for the same
            reason includeAppointmentDetails does: "allocate" is the
            consultant's surface, everything else is a buyer's. */}
        <SlotStatusLegend
          keys={
            props.mode === "allocate"
              ? CONSULTANT_LEGEND_KEYS
              : BUYER_LEGEND_KEYS
          }
          className="shrink-0"
        />
        <UnifiedCalendar {...props} className="min-h-0 flex-1" />
      </div>
    </CalendarErrorBoundary>
  );
}
