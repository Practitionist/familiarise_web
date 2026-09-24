"use client";

import { formatInTimeZone } from "date-fns-tz";
import { useEffect, useState } from "react";

import { eventRefundWindowHours } from "@/lib/payments/operations/cancellation-policy";

/**
 * #1780 D-6 — "Free cancellation until <start − window>", in the viewer's own
 * zone. Rendered after mount: the zone is only knowable in the browser.
 */
export function FreeCancellationLine({
  startsAt,
  windowHours,
  className = "text-sm text-muted-foreground",
}: Readonly<{
  startsAt: Date | string | null | undefined;
  windowHours: number | null | undefined;
  className?: string;
}>) {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  if (!startsAt || !zone) return null;
  const until = new Date(
    new Date(startsAt).getTime() -
      eventRefundWindowHours(null, windowHours) * 3_600_000,
  );
  const when = formatInTimeZone(until, zone, "EEE d MMM, h:mm a zzz");
  return (
    <p className={className}>
      {until.getTime() > Date.now()
        ? `Free cancellation until ${when}.`
        : `Free cancellation ended ${when}; a seat can no longer be refunded.`}
    </p>
  );
}
