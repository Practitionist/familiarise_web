"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface Attendance {
  bookedMinutes: number;
  seats: { userId: string; name: string | null; presentMinutes: number }[];
}

/**
 * #1569 B-4 — the host's "who attended" list for one session, read from the
 * per-device presence rows; fetched only when opened.
 */
export function SessionAttendance({
  appointmentId,
  occurrenceId,
}: Readonly<{ appointmentId: string; occurrenceId: string }>) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["session-attendance", occurrenceId],
    queryFn: async () => {
      const res = await fetch(
        `/api/appointments/${appointmentId}/occurrences/${occurrenceId}/attendance`,
      );
      if (!res.ok) throw new Error("Failed to load attendance");
      return (await res.json()) as Attendance;
    },
    enabled: open,
    staleTime: 60_000,
  });
  return (
    <details
      className="text-xs text-muted-foreground"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer">Who attended</summary>
      {query.isError && <p>Attendance could not be loaded.</p>}
      {query.data && query.data.seats.length === 0 && (
        <p>No learners hold this session.</p>
      )}
      <ul className="mt-1 space-y-0.5">
        {query.data?.seats.map((s) => (
          <li key={s.userId}>
            {s.name ?? "A learner"}: {s.presentMinutes} of{" "}
            {query.data.bookedMinutes} minutes
          </li>
        ))}
      </ul>
    </details>
  );
}
