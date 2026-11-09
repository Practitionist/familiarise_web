import { useZonedFormat } from "@/lib/time/zoned-format";
import type { TimelineEvent } from "@/lib/dashboard/money-state";
import { cn } from "@/utils/tailwind";

/**
 * The booking's story as a vertical stepper: filled dots for what has
 * happened, hollow for what comes next. A failed refund step is drawn in the
 * destructive colour so it cannot read as done.
 */
export function TimelineStrip({ events }: { events: TimelineEvent[] }) {
  const format = useZonedFormat();
  if (events.length === 0) return null;
  return (
    <ol className="relative space-y-3 text-sm">
      {events.map((event, i) => {
        const failed = event.kind === "refund-failed";
        return (
          <li key={`${event.label}-${i}`} className="relative flex gap-3">
            {i < events.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[5px] top-4 h-[calc(100%+0.25rem)] w-px bg-border"
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2",
                event.done
                  ? "border-foreground bg-foreground"
                  : "border-muted-foreground/50 bg-card",
                failed && "border-destructive bg-destructive",
              )}
            />
            <div className="min-w-0">
              <p
                className={cn(
                  event.done
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                  failed && "text-destructive",
                )}
              >
                <span className="sr-only">
                  {event.done ? "Done: " : "Next: "}
                </span>
                {event.label}
              </p>
              {event.at && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {format(event.at, "EEE d MMM, HH:mm")}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
