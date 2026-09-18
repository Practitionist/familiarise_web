"use client";

import dynamic from "next/dynamic";
import type { UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";
import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import { SlotStatusLegend } from "./SlotStatusLegend";
import {
  BUYER_LEGEND_KEYS,
  CONSULTANT_LEGEND_KEYS,
  type SlotStatusKey,
} from "@/lib/scheduling/interval-status-tokens";
import { cn } from "@/utils/tailwind";

const UnifiedCalendar = dynamic(
  () =>
    import("./UnifiedCalendar").then((m) => ({ default: m.UnifiedCalendar })),
  {
    ssr: false,
    loading: () => <CalendarGridSkeleton className="min-h-0 flex-1" />,
  },
);

/**
 * Mounts the legend alongside the calendar.
 *
 * The grid has always coloured cells in seven distinct states and never said
 * what any of them meant, so a consultant seeing a yellow cell had to guess
 * whether it was bookable. Putting the legend here rather than inside
 * UnifiedCalendar means every caller gets it and none can forget it.
 *
 * UnifiedCalendar itself is code-split here so TimePicker / allocate /
 * reschedule routes do not pay the calendar module on first paint of the
 * surrounding page chrome.
 */
export function SafeUnifiedCalendar({
  className,
  legendPosition = "top",
  legendKeys,
  ...props
}: UnifiedCalendarProps & {
  /** The rows the legend shows; defaults by mode. `consultantLegendKeys`
   * trims the consultant set to what the surface can paint (#1703 F4). */
  legendKeys?: SlotStatusKey[];
  /**
   * Where the legend renders. Above the grid by default: a key you can only
   * reach by scrolling past the thing it explains is backwards, and on a
   * laptop it sat below the fold entirely (#1064). "bottom" renders it
   * between the grid and the action footer instead — still on screen, since
   * the footer is always visible — for surfaces that need the top space for
   * the heatmap itself (allocate page).
   */
  legendPosition?: "top" | "bottom";
}) {
  const legend = (
    <SlotStatusLegend
      keys={
        legendKeys ??
        ((props.showConsultantLegend ?? props.mode === "allocate")
          ? CONSULTANT_LEGEND_KEYS
          : BUYER_LEGEND_KEYS)
      }
      className="shrink-0"
    />
  );
  return (
    <CalendarErrorBoundary>
      {/* The caller's layout classes go on the WRAPPER, not the calendar: this
          div is what their flex parent measures now, so leaving `min-h-0
          flex-1` on the inner element sized a child of a plain block box and
          the calendar stopped filling its dialog. */}
      <div className={cn("flex min-h-0 flex-col gap-3", className)}>
        {/* Above the grid, not below: a key you can only reach by scrolling
            past the thing it explains is backwards, and on a laptop it sat
            below the fold entirely (#1064). Buyers have no use for "This
            booking" / "Being moved"; consultants do on allocate AND on
            reschedule-propose (select mode with event context). Prefer the
            explicit prop; fall back to mode === "allocate". */}
        {legendPosition === "top" && legend}
        <UnifiedCalendar
          {...props}
          className="min-h-0 flex-1"
          aboveActionsSlot={legendPosition === "bottom" ? legend : undefined}
        />
      </div>
    </CalendarErrorBoundary>
  );
}
