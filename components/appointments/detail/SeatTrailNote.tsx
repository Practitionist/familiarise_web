"use client";

import { useQuery } from "@tanstack/react-query";

import { seatTrailLine } from "@/lib/booking/seat-trail-copy";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { SeatTrailResponseSchema } from "@/schemas/seat-removal-lift";

const TRAIL_DAY = "d MMM";

/** The learner's own seat history on an event ("Left 12 Nov · rejoined 13 Nov"); nothing for a plain registration. */
export function SeatTrailNote({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const viewerZone = useViewerZone();
  const trail = useQuery({
    queryKey: ["seat-trail", appointmentId],
    queryFn: async () => {
      const res = await fetch(`/api/appointments/${appointmentId}/seat-trail`);
      if (!res.ok) return { steps: [] };
      return SeatTrailResponseSchema.parse(await res.json());
    },
    staleTime: 60_000,
  });
  const line = seatTrailLine(trail.data?.steps ?? [], (iso) =>
    formatInViewerZone(iso, viewerZone.zone, TRAIL_DAY),
  );
  if (!line) return null;
  return <p className="text-xs text-muted-foreground">Your seat: {line}</p>;
}
