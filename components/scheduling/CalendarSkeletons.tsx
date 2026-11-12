import { GRID_COLS } from "@/lib/scheduling/week-grid-geometry";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/utils/tailwind";

/**
 * The scheduling grid while it loads, in the grid's own geometry: the context
 * row, the toolbar, a 64px day header over 24px half-hour rows, and the
 * session tray (right of the grid from 1280px, under it below), so nothing
 * shifts when the data lands.
 */
export function CalendarGridSkeleton({
  className,
}: Readonly<{ className?: string }>) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
      <div className="flex flex-wrap gap-2">
        {["w-28", "w-36", "w-32", "w-40"].map((width) => (
          <Skeleton key={width} className={cn("h-5 rounded-full", width)} />
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <Skeleton className="h-9 w-9" />
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-9" />
            </div>
            <Skeleton className="h-7 w-40" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className={cn(GRID_COLS, "h-16 border-b-2 border-slate-300")}>
              <div />
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={`h-${i}`}
                  className="flex flex-col items-center justify-center gap-1 border-l border-slate-200"
                >
                  <Skeleton className="h-3 w-8" />
                  <Skeleton className="h-5 w-6" />
                </div>
              ))}
            </div>
            {Array.from({ length: 16 }).map((_, row) => (
              <div key={`row-${row}`} className={GRID_COLS}>
                <div className="flex h-6 items-start justify-end pr-2">
                  {row % 2 === 0 && <Skeleton className="h-2.5 w-8" />}
                </div>
                {Array.from({ length: 7 }).map((_, col) => (
                  <div
                    key={`c-${row}-${col}`}
                    className={cn(
                      "h-6 border-l border-slate-200 border-b",
                      row % 2 === 0
                        ? "border-dashed border-b-slate-200"
                        : "border-b-slate-300",
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-3 rounded-lg border border-border p-3 xl:w-80">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <div className="mt-auto flex justify-end gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Allocate / reschedule / timings page: header + calendar + footer. */
export function HeatmapSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex shrink-0 items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-4 w-full max-w-xl" />
      <CalendarGridSkeleton />
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-36" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
  );
}
