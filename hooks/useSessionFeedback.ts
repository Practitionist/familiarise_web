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
export interface SessionFeedbackState {
  /** slot id → the rating this viewer gave it. */
  ratings: Record<string, number>;
  /** Slots this viewer may rate at all — attended, or offline. */
  rateable: Set<string>;
}

export function useSessionFeedback(
  appointmentIds: readonly string[],
): SessionFeedbackState {
  const results = useQueries({
    queries: appointmentIds.map((appointmentId) => ({
      queryKey: ["appointment-feedback", appointmentId],
      queryFn: async (): Promise<{
        ratings: Record<string, number>;
        rateable: string[];
      }> => {
        const res = await fetch(`/api/appointments/${appointmentId}/feedback`);
        if (!res.ok) return { ratings: {}, rateable: [] };
        const { data, rateableSlotIds } = await res.json();
        const rows = (data ?? []) as SlotFeedback[];
        // A provider's read returns EVERY attendee's rating, so a group call
        // yields several rows for one slot. `Object.fromEntries` kept whichever
        // came last — the consultant saw one arbitrary attendee's score and
        // read it as the session's. Averaged instead, which is also how that
        // call contributes to the rating unit.
        const bySlot = new Map<string, { total: number; n: number }>();
        for (const r of rows) {
          if (!r.slotOfAppointmentId) continue;
          const acc = bySlot.get(r.slotOfAppointmentId) ?? { total: 0, n: 0 };
          acc.total += r.rating;
          acc.n += 1;
          bySlot.set(r.slotOfAppointmentId, acc);
        }
        return {
          ratings: Object.fromEntries(
            [...bySlot].map(([slotId, a]) => [
              slotId,
              Math.round((a.total / a.n) * 10) / 10,
            ]),
          ),
          rateable: (rateableSlotIds ?? []) as string[],
        };
      },
    })),
  });
  return {
    ratings: Object.assign({}, ...results.map((r) => r.data?.ratings ?? {})),
    rateable: new Set(results.flatMap((r) => r.data?.rateable ?? [])),
  };
}
