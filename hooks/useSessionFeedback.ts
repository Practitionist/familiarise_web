/**
 * The timeline's per-call feedback for one booking, in ONE request (#1540).
 *
 * #1554 — a booking is one `Appointment` carrying every call as an occurrence
 * row, so one read covers the whole timeline; `scope=booking` is kept on the
 * URL for the server's older callers and reads the same row.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RatingCause } from "@prisma/client";
import { throwSupportError } from "@/lib/support/error-copy";

interface SlotFeedback {
  appointmentOccurrenceId: string | null;
  rating: number;
  comment?: string | null;
  ratingCause?: RatingCause | null;
}

export interface SubmitFeedbackInput {
  rating: number;
  comment?: string;
  occurrenceId?: string;
  ratingCause?: RatingCause | null;
}

/** The one cache key for a booking's ratings.
 *
 *  Exported because `SessionRatingRow` writes a rating for a CHILD appointment and
 *  has to invalidate the BOOKING's entry — invalidating its own child id would
 *  leave the stars unchanged after a save, which is the bug the per-appointment
 *  keys created the moment the reads were consolidated. */
export const bookingFeedbackKey = (bookingAppointmentId: string) =>
  ["booking-feedback", bookingAppointmentId] as const;

export interface SessionFeedbackState {
  /** slot id → the rating this viewer gave it. */
  ratings: Record<string, number>;
  /** slot id (or "booking") → the private comment this viewer saved. */
  comments: Record<string, string>;
  /** slot id (or "booking") → the low-rating cause this viewer selected. */
  ratingCauses: Record<string, RatingCause>;
  /** Slots this viewer may rate at all — attended, or offline. */
  rateable: Set<string>;
  /** Persist a session rating and optional private comment. */
  submitFeedback: (input: SubmitFeedbackInput) => Promise<void>;
  /** True while a feedback submission is in flight. */
  isSubmitting: boolean;
  /**
   * True when the read failed.
   *
   * The query throws so React Query records the failure and retries, but the
   * aggregation below reads optional data — so a failed read contributed no
   * ratings and no rateable slots, which renders identically to "you have rated
   * nothing here and may rate nothing here". A transient 500 would tell somebody
   * their rating never happened.
   */
  isError: boolean;
  /** Re-run the read. */
  retry: () => void;
}

export function useSessionFeedback(
  bookingAppointmentId: string,
): SessionFeedbackState {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const query = useQuery({
    queryKey: bookingFeedbackKey(bookingAppointmentId),
    queryFn: async (): Promise<{
      ratings: Record<string, number>;
      comments: Record<string, string>;
      ratingCauses: Record<string, RatingCause>;
      rateable: string[];
    }> => {
      const res = await fetch(
        `/api/appointments/${bookingAppointmentId}/feedback?scope=booking`,
      );
      // A failed read is NOT "you have rated nothing". Returning an empty result
      // made React Query record success, skip its retry and cache the emptiness,
      // so a 500 rendered as unrated stars on a call the user had already rated.
      if (!res.ok) await throwSupportError(res, "session feedback load");
      const json: {
        data?: SlotFeedback[];
        rateableSlotIds?: string[];
      } = await res.json();
      const rows = json.data ?? [];
      // A provider's read returns EVERY attendee's rating, so a group call yields
      // several rows for one slot. `Object.fromEntries` kept whichever came last —
      // the consultant saw one arbitrary attendee's score and read it as the
      // session's. Averaged instead, which is also how that call contributes to
      // the group score.
      const bySlot = new Map<string, { total: number; n: number }>();
      const comments: Record<string, string> = {};
      const ratingCauses: Record<string, RatingCause> = {};
      for (const r of rows) {
        const commentKey = r.appointmentOccurrenceId ?? "booking";
        if (typeof r.comment === "string" && r.comment.length > 0) {
          comments[commentKey] = r.comment;
        }
        if (r.ratingCause) {
          ratingCauses[commentKey] = r.ratingCause;
        }
        if (!r.appointmentOccurrenceId) continue;
        const acc = bySlot.get(r.appointmentOccurrenceId) ?? { total: 0, n: 0 };
        acc.total += r.rating;
        acc.n += 1;
        bySlot.set(r.appointmentOccurrenceId, acc);
      }
      return {
        ratings: Object.fromEntries(
          [...bySlot].map(([slotId, a]) => [
            slotId,
            Math.round((a.total / a.n) * 10) / 10,
          ]),
        ),
        comments,
        ratingCauses,
        rateable: json.rateableSlotIds ?? [],
      };
    },
  });

  const submitFeedback = async (input: SubmitFeedbackInput) => {
    setIsSubmitting(true);
    try {
      const trimmedComment = input.comment?.trim();
      const res = await fetch(
        `/api/appointments/${bookingAppointmentId}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rating: input.rating,
            ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
            ...(trimmedComment !== undefined
              ? { comment: trimmedComment }
              : {}),
            ...(input.ratingCause !== undefined
              ? { ratingCause: input.ratingCause }
              : {}),
          }),
        },
      );
      if (!res.ok) await throwSupportError(res, "session feedback save");
      await queryClient.invalidateQueries({
        queryKey: bookingFeedbackKey(bookingAppointmentId),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    ratings: query.data?.ratings ?? {},
    comments: query.data?.comments ?? {},
    ratingCauses: query.data?.ratingCauses ?? {},
    rateable: new Set(query.data?.rateable ?? []),
    submitFeedback,
    isSubmitting,
    isError: query.isError,
    retry: () => void query.refetch(),
  };
}
