"use client";

import { UnifiedCalendar, UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";
import { SlotStatusLegend } from "./SlotStatusLegend";
import { CONSULTANT_LEGEND_KEYS } from "@/lib/scheduling/slot-status-tokens";
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
        <UnifiedCalendar {...props} className="min-h-0 flex-1" />
        <SlotStatusLegend keys={CONSULTANT_LEGEND_KEYS} className="shrink-0" />
      </div>
    </CalendarErrorBoundary>
  );
}
