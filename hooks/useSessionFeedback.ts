/**
 * #705 — this viewer's per-call ratings for one booking, keyed by slot id.
 *
 * The feedback GET returns every call of the booking the caller has rated, so
 * the session timeline can show which are already rated without a request per
 * row.
 */

import { useQueries } from "@tanstack/react-query";

interface SlotFeedback {
  slotOfAppointmentId: string | null;
  rating: number;
}

/**
 * Sessions in a subscription or class group belong to DIFFERENT appointments —
 * `SessionVM.appointmentId` differs per row — so fetching only the page's own
 * appointment left every child session looking unrated, and its invalidation
 * key pointed at the wrong query.
 */
export function useSessionFeedback(
  appointmentIds: readonly string[],
): Record<string, number> {
  const results = useQueries({
    queries: appointmentIds.map((appointmentId) => ({
      queryKey: ["appointment-feedback", appointmentId],
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
    })),
  });
  return Object.assign({}, ...results.map((r) => r.data ?? {}));
}
