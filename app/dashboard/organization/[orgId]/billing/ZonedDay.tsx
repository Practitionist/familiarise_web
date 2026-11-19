"use client";

import { useZonedFormat } from "@/lib/time/zoned-format";

/** A day in the profile zone the org layout pins, so the server and the browser print one date. */
export function ZonedDay({ at }: Readonly<{ at: string }>) {
  const format = useZonedFormat();
  return <>{format(at, "d MMM yyyy")}</>;
}
