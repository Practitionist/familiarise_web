"use client";

/**
 * #appt-support — private per-participant CSAT for a finished session (1–5 +
 * note), distinct from the public ConsultantReview. Upserts, so it doubles as
 * an edit surface. The parent decides WHEN to show it (past/completed session).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

interface Feedback {
  rating: number;
  comment: string | null;
}

export function AppointmentCsatCard({ appointmentId }: { appointmentId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = ["appointment-feedback", appointmentId] as const;

  const { data: existing } = useQuery({
    queryKey,
    queryFn: async (): Promise<Feedback | null> => {
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`);
      if (!res.ok) await throwSupportError(res, "feedback load");
      const { data } = await res.json();
      return data;
    },
  });

  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (existing) {
      setRating(existing.rating);
      setComment(existing.comment ?? "");
    }
  }, [existing]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      if (!res.ok) await throwSupportError(res, "feedback save");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Thanks for the feedback" });
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) =>
      toast({
        title: "Feedback",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      }),
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {existing ? "Your feedback" : "How was this session?"}
      </p>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            className="p-0.5"
          >
            <Star
              className={
                "h-6 w-6 transition-colors " +
                ((hover || rating) >= n
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground")
              }
            />
          </button>
        ))}
      </div>
      <Textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Anything you'd like to add? (optional)"
        className="mt-3"
        rows={3}
      />
      <Button
        className="mt-3"
        size="sm"
        disabled={rating < 1 || save.isPending}
        onClick={() => save.mutate()}
      >
        {existing ? "Update feedback" : "Submit feedback"}
      </Button>
    </div>
  );
}
