"use client";

import { UnifiedCalendar, UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";
import { SlotStatusLegend } from "./SlotStatusLegend";
import { CONSULTANT_LEGEND_KEYS } from "@/lib/scheduling/slot-status-tokens";

/**
 * Mounts the legend alongside the calendar.
 *
 * The grid has always coloured cells in seven distinct states and never said
 * what any of them meant, so a consultant seeing a yellow cell had to guess
 * whether it was bookable. Putting the legend here rather than inside
 * UnifiedCalendar means every caller gets it and none can forget it.
 */
export function SafeUnifiedCalendar(props: UnifiedCalendarProps) {
  return (
    <CalendarErrorBoundary>
      <div className="space-y-3">
        <UnifiedCalendar {...props} />
        <SlotStatusLegend keys={CONSULTANT_LEGEND_KEYS} />
      </div>
    </CalendarErrorBoundary>
  );
}
