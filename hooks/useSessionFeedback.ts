/**
 * #705 — this viewer's per-call ratings for one booking, keyed by slot id.
 *
 * The feedback GET returns every call of the booking the caller has rated, so
 * the session timeline can show which are already rated without a request per
 * row.
 */

import { useQuery } from "@tanstack/react-query";

interface SlotFeedback {
  slotOfAppointmentId: string | null;
  rating: number;
}

export function useSessionFeedback(appointmentId: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ["appointment-feedback", appointmentId],
    enabled,
    queryFn: async (): Promise<Record<string, number>> => {
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`);
      if (!res.ok) return {};
      const { data } = await res.json();
      const rows = (data ?? []) as SlotFeedback[];
      return Object.fromEntries(
        rows
          .filter((r) => r.slotOfAppointmentId)
          .map((r) => [r.slotOfAppointmentId as string, r.rating]),
      );
    },
  });
  return data ?? {};
}
