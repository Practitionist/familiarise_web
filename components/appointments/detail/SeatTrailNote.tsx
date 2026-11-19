"use client";

import { useQuery } from "@tanstack/react-query";

import { seatTrailText } from "@/lib/booking/seat-trail-copy";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { fetchSeatTrail } from "@/lib/booking/seat-trail-fetch";

/** The learner's own seat history on an event ("Left 12 Nov · rejoined 13 Nov (IST)"); nothing for a plain registration. */
export function SeatTrailNote({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const viewerZone = useViewerZone();
  const trail = useQuery({
    queryKey: ["seat-trail", appointmentId],
    queryFn: () => fetchSeatTrail(appointmentId),
    staleTime: 60_000,
  });
  const { line, full } = seatTrailText(
    trail.data?.steps ?? [],
    viewerZone.zone,
  );
  if (!line) return null;
  return (
    <p className="text-xs text-muted-foreground" title={full}>
      Your seat: {line}
    </p>
  );
}
