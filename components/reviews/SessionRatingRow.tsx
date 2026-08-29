"use client";

/**
 * #705 — the private rating for ONE video call, rendered on the session it
 * belongs to.
 *
 * This replaces the standalone CSAT card. That card asked for a rating of "the
 * appointment", which on a subscription booking meant a single score for up to
 * twenty-four calls; and it sat directly above the public review card looking
 * almost identical, so the page read as asking the same question twice. Putting
 * the stars on the session row attaches the question to the thing being
 * answered and removes the duplicate entirely.
 *
 * The consultant sees these, so the copy says so — see AppointmentDetailClient.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

export function SessionRatingRow({
  appointmentId,
  slotId,
  existingRating,
}: {
  appointmentId: string;
  slotId: string;
  existingRating: number | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rating, setRating] = useState(existingRating ?? 0);
  const [hover, setHover] = useState(0);

  useEffect(() => {
    setRating(existingRating ?? 0);
  }, [existingRating, slotId]);

  const save = useMutation({
    mutationFn: async (value: number) => {
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: value, slotId }),
      });
      if (!res.ok) await throwSupportError(res, "session rating");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["appointment-feedback", appointmentId],
      });
    },
    onError: (e: unknown, _value, previous) => {
      // Put the stars back where they were: leaving the new value on screen
      // claims a rating we did not store.
      setRating(
        typeof previous === "number" ? previous : (existingRating ?? 0),
      );
      toast({
        title: "Rating",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <div
      className="flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={save.isPending}
          aria-label={`Rate ${n} out of 5`}
          aria-pressed={rating === n}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={(e) => {
            e.stopPropagation();
            const previous = rating;
            setRating(n);
            save.mutate(n, { onError: () => setRating(previous) });
          }}
          className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <Star
            className={
              "h-3.5 w-3.5 " +
              ((hover || rating) >= n
                ? "fill-foreground text-foreground"
                : "text-muted-foreground/50")
            }
          />
        </button>
      ))}
    </div>
  );
}
