"use client";

import { useZonedFormat } from "@/lib/time/zoned-format";

/** A day (or a day and time) in the profile zone the org layout pins, so every Billing view prints one date. */
export function ZonedDay({
  at,
  withTime = false,
}: Readonly<{ at: string | null; withTime?: boolean }>) {
  const format = useZonedFormat();
  if (!at) return <>—</>;
  return <>{format(at, withTime ? "d MMM yyyy, h:mm a" : "d MMM yyyy")}</>;
}
