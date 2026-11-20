import {
  SeatTrailResponseSchema,
  type SeatTrailResponse,
} from "@/schemas/seat-removal-lift";

/** The caller's own seat trail on one event; a failed read throws so it is retried, never cached as empty. */
export async function fetchSeatTrail(
  appointmentId: string,
): Promise<SeatTrailResponse> {
  const res = await fetch(`/api/appointments/${appointmentId}/seat-trail`);
  if (!res.ok) throw new Error("Failed to load your seat history");
  return SeatTrailResponseSchema.parse(await res.json());
}
