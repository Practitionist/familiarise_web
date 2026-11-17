import { useMemo } from "react";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { nextAvailableWindow } from "@/lib/scheduling/booking-windows";
import { useAvailabilityMonth } from "@/lib/scheduling/use-availability-window";

interface NextAvailableInput {
  consultantId: string | undefined;
  /** Today as a calendar date in `timezone` (its local fields are read). */
  today: Date;
  now: Date;
  timezone: string;
  zoneReady: boolean;
  consulteeUserId: string | undefined;
  durationInHours: number;
}

/**
 * "Tue 10 Nov, 4:00 PM IST" for the earliest window the picker would offer, or
 * null. Reads this month, and next month only when this one has nothing left;
 * both reads share cache entries with the calendar's own month read.
 */
export function useNextAvailableLabel({
  consultantId,
  today,
  now,
  timezone,
  zoneReady,
  consulteeUserId,
  durationInHours,
}: NextAvailableInput): string | null {
  const nowMs = now.getTime();
  const thisMonth = useAvailabilityMonth({
    consultantId,
    monthStart: new Date(today.getFullYear(), today.getMonth(), 1),
    timezone: zoneReady ? timezone : null,
    consulteeUserId,
  });
  const inThisMonth = useMemo(
    () =>
      thisMonth.data
        ? nextAvailableWindow(thisMonth.data, durationInHours, timezone, nowMs)
        : null,
    [thisMonth.data, durationInHours, timezone, nowMs],
  );

  const needNextMonth = zoneReady && thisMonth.isSuccess && !inThisMonth;
  const nextMonth = useAvailabilityMonth({
    consultantId,
    monthStart: new Date(today.getFullYear(), today.getMonth() + 1, 1),
    timezone: needNextMonth ? timezone : null,
    consulteeUserId,
  });
  const inNextMonth = useMemo(
    () =>
      nextMonth.data
        ? nextAvailableWindow(nextMonth.data, durationInHours, timezone, nowMs)
        : null,
    [nextMonth.data, durationInHours, timezone, nowMs],
  );

  const next = inThisMonth ?? inNextMonth;
  return next
    ? formatInViewerZone(
        new Date(next.startsAt),
        timezone,
        "EEE d MMM, h:mm a zzz",
      )
    : null;
}
