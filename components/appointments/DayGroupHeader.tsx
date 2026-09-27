"use client";

import { formatInViewerZone } from "@/lib/time/viewer-zone";

const DAY_KEY = "yyyy-MM-dd";
const DAY_MS = 86_400_000;

/**
 * Day captions in the viewer's zone (#1527 QA): date-fns `isToday`/`format`
 * read the runtime zone, so Netlify (UTC) and the browser disagreed and React
 * threw hydration error #418 on the Appointments list.
 */
export function dayGroupLabel(
  date: Date | null,
  zone: string,
  now: Date = new Date(),
): string {
  if (!date) return "Unscheduled";
  const day = formatInViewerZone(date, zone, DAY_KEY);
  const short = formatInViewerZone(date, zone, "EEE, d MMM");
  const relative = (offsetDays: number) =>
    formatInViewerZone(now.getTime() + offsetDays * DAY_MS, zone, DAY_KEY);
  if (day === relative(0)) return `Today · ${short}`;
  if (day === relative(1)) return `Tomorrow · ${short}`;
  if (day === relative(-1)) return `Yesterday · ${short}`;
  return formatInViewerZone(date, zone, "EEEE, d MMM yyyy");
}

export function DayGroupHeader({
  date,
  zone,
}: Readonly<{ date: Date | null; zone: string }>) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
        {dayGroupLabel(date, zone)}
      </p>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
