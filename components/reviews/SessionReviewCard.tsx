"use client";

/**
 * #705 — the PUBLIC review of one session, and the first submission surface
 * this product has ever had. `/api/user/reviews` had no caller: the expert page
 * invited people to "Be the first to leave a review!" and there was nowhere to
 * do it, so the entire review corpus could only come from seeds.
 *
 * Deliberately distinct from `AppointmentCsatCard` beside it. That one is a
 * PRIVATE rating that feeds the org quality signal; this one is a consumer
 * review that appears on the consultant's profile. FTC 16 CFR 465.1(d) makes a
 * bare star rating a "consumer review", so merging the two would quietly turn
 * private feedback into a published one.
 *
 * Shown to every attendee of every held session, identically and without
 * asking how they feel first — the preamble to that rule is explicit that
 * soliciting only the customers you believe are happy is not a "generalized
 * solicitation". It is also the J-shape mitigation, and it is why there is no
 * "enjoying your session?" gate here. Nothing is offered in exchange either:
 * the Airbnb programme that tested incentives found incentivised reviews MORE
 * negative, with no revenue effect.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

interface ReviewableSession {
  appointmentId: string;
  title: string;
  existingReview: {
    id: string;
    rating: number;
    reviewDescription: string | null;
  } | null;
}

export function SessionReviewCard({
  appointmentId,
}: {
  appointmentId: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = ["reviewable-session", appointmentId] as const;

  const { data: session } = useQuery({
    queryKey,
    queryFn: async (): Promise<ReviewableSession | null> => {
      const res = await fetch(
        `/api/user/reviews/reviewable-sessions?appointmentId=${encodeURIComponent(appointmentId)}`,
      );
      if (!res.ok) await throwSupportError(res, "review eligibility");
      const { data } = await res.json();
      return (data as ReviewableSession[])[0] ?? null;
    },
  });

  const existing = session?.existingReview ?? null;
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");

  useEffect(() => {
    // Reset on absence too, and key on the appointment: without either, moving
    // to a session you have NOT reviewed kept the previous session's stars and
    // text sitting in the form, ready to be posted against the wrong session.
    setRating(existing?.rating ?? 0);
    setText(existing?.reviewDescription ?? "");
  }, [existing, appointmentId]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        rating,
        reviewDescription: text.trim() || undefined,
      };
      const res = existing
        ? await fetch(`/api/user/reviews/${existing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/user/reviews`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, appointmentId }),
          });
      if (!res.ok) await throwSupportError(res, "review save");
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: existing ? "Review updated" : "Thanks for your review",
        description: "It appears on the expert's public profile.",
      });
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) => {
      toast({
        title: "Review",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Not eligible, or the eligibility check has not answered yet. Rendering a
  // disabled form to someone who may never be allowed to use it is worse than
  // rendering nothing.
  if (!session) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium text-foreground">
        {existing ? "Your public review" : "Review this session publicly"}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        This one is public — it appears on the expert&apos;s profile with your
        name and the date. Your private rating above stays between you and us.
      </p>

      <div className="mt-3 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            // Every star is the same size and the same affordance. Making the
            // high ones easier to press is a named dark pattern under the CCPA
            // 2023 guidelines, and it is also how a rating stops being data.
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={rating === n}
            className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Star
              className={
                "h-6 w-6 " +
                ((hover || rating) >= n
                  ? "fill-foreground text-foreground"
                  : "text-muted-foreground")
              }
            />
          </button>
        ))}
      </div>

      <Textarea
        className="mt-3"
        rows={3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What was useful, and what could have been better? (optional)"
      />

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={rating === 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? "Update review" : "Post review"}
        </Button>
        {/* No confirm-shaming on a low rating: "are you sure you only want to
            give 3 stars?" is a named dark pattern, and it manufactures the
            J-shape it pretends to measure. */}
        <span className="text-xs text-muted-foreground">
          You can edit this later.
        </span>
      </div>
    </section>
  );
}
