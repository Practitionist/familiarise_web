import { format } from "date-fns";
import type { TimelineEvent } from "@/lib/dashboard/money-state";
import { cn } from "@/utils/tailwind";

/**
 * #1675 — the booking's story in one line: what has happened (●) and what
 * comes next (○), from `deriveBookingPresentation`. Future steps are muted
 * so the strip reads as a path, not as three more states.
 */
export function TimelineStrip({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-card px-5 py-3 shadow-sm">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Timeline
      </p>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {events.map((event, i) => (
          <li
            key={`${event.label}-${i}`}
            className={cn(
              "flex items-center gap-1.5",
              event.done ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/60">
                →
              </span>
            )}
            <span aria-hidden>{event.done ? "●" : "○"}</span>
            <span className={cn(event.done && "font-medium")}>
              {event.label}
              {event.at && (
                <span className="font-normal text-muted-foreground">
                  {" · "}
                  {format(event.at, "EEE d MMM HH:mm")}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
