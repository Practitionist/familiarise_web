"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

/** What the client reads of a plan's Regular time. */
interface SummaryDto {
  label: string | null;
  timeZone: string;
  weeks: { placed: { startsAt: string }[] }[];
}

/**
 * The client's read-only line: "Your regular time: Mon, Wed, Fri at 18:00
 * (Asia/Kolkata)" and the next sessions it booked. Nothing for a booking
 * without one.
 */
export function RegularTimeSummary({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const [view, setView] = useState<SummaryDto | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(
      `/api/appointments/${encodeURIComponent(appointmentId)}/regular-time`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? (r.json() as Promise<SummaryDto>) : null))
      .then((dto) => {
        if (live) setView(dto);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [appointmentId]);

  if (!view?.label) return null;
  const now = Date.now();
  const next = view.weeks
    .flatMap((w) => w.placed)
    .filter((p) => Date.parse(p.startsAt) > now)
    .slice(0, 3);
  return (
    <div className="rounded-md border p-3 text-sm" aria-label="Regular time">
      <p className="font-medium">
        Your regular time: {view.label} ({view.timeZone})
      </p>
      {next.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          Next:{" "}
          {next
            .map((p) =>
              formatInTimeZone(
                new Date(p.startsAt),
                view.timeZone,
                "EEE d MMM, HH:mm",
              ),
            )
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
