"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { UnifiedCalendarProps } from "./UnifiedCalendar";
import CalendarErrorBoundary from "./CalendarErrorBoundary";
import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import { SlotStatusLegend } from "./SlotStatusLegend";
import {
  BUYER_LEGEND_KEYS,
  CONSULTANT_LEGEND_KEYS,
  legendKeysFor,
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
 * Hands the calendar its legend so no caller can forget it (the calendar puts
 * it in the session tray), keeps a crash inside an error boundary whose retry
 * remounts the grid, and code-splits the calendar out of the surrounding page.
 */
export function SafeUnifiedCalendar({
  className,
  ...props
}: UnifiedCalendarProps) {
  // Null until the first report, so the legend shows the full set while loading.
  const [painted, setPainted] = useState<{
    keys: ReadonlySet<SlotStatusKey> | null;
    counts?: ReadonlyMap<SlotStatusKey, number>;
  }>({ keys: null });
  const [mountKey, setMountKey] = useState(0);
  const handlePainted = useCallback(
    (
      keys: ReadonlySet<SlotStatusKey>,
      counts?: ReadonlyMap<SlotStatusKey, number>,
    ) => setPainted({ keys, counts }),
    [],
  );
  const order =
    (props.showConsultantLegend ?? props.mode === "allocate")
      ? CONSULTANT_LEGEND_KEYS
      : BUYER_LEGEND_KEYS;
  const legend = (
    <SlotStatusLegend
      keys={legendKeysFor(order, painted.keys)}
      counts={painted.counts}
      showRequested={Boolean(props.requestedSlots?.length)}
      className="shrink-0"
    />
  );
  return (
    <CalendarErrorBoundary onRetry={() => setMountKey((key) => key + 1)}>
      {/* Layout classes go on the wrapper: it is what the flex parent measures. */}
      <div className={cn("flex min-h-0 flex-col", className)}>
        <UnifiedCalendar
          key={mountKey}
          {...props}
          onPaintedKeysChange={handlePainted}
          className="min-h-0 flex-1"
          legend={legend}
        />
      </div>
    </CalendarErrorBoundary>
  );
}
