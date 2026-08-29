"use client";

/**
 * #705 — the PUBLIC review of one session, and the first submission surface
 * this product has ever had. `/api/user/reviews` had no caller: the expert page
 * invited people to "Be the first to leave a review!" and there was nowhere to
 * do it, so the entire review corpus could only come from seeds.
 *
 * Deliberately distinct from the per-call rating on the session rows above
 * (`SessionRatingRow`). That one is a PRIVATE rating of a single call; this is
 * a consumer review of the CONSULTANT, one per person, editable. FTC 16 CFR
 * 465.1(d) makes a bare star rating a "consumer review", so merging the two
 * would quietly turn private feedback into a published one.
 *
 * Shown to every attendee of every held session, identically and without
 * asking how they feel first — the preamble to that rule is explicit that
 * soliciting only the customers you believe are happy is not a "generalized
 * solicitation". It is also the J-shape mitigation, and it is why there is no
 * "enjoying your session?" gate here. Nothing is offered in exchange either:
 * the Airbnb programme that tested incentives found incentivised reviews MORE
 * negative, with no revenue effect.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

interface ReviewableSession {
  appointmentId: string;
  consultantName: string | null;
  title: string;
  existingReview: {
    id: string;
    rating: number;
    reviewDescription: string | null;
    isAnonymous?: boolean;
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

  const {
    data: session,
    isError,
    isLoading,
    refetch,
  } = useQuery({
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
  const [anonymous, setAnonymous] = useState(false);

  // Seed the form from the stored review ONCE per review, not on every render
  // of a new `existing` object. React Query hands back a fresh object on each
  // refetch, so depending on its identity meant the 15s poll silently reset the
  // textarea to the saved text — and a user who had just cleared it submitted
  // the old value back. Keyed on the review id (and null, for "not written
  // yet") so switching sessions still re-seeds.
  const seededFor = useRef<string | null>(null);
  const seedKey = existing?.id ?? `none:${appointmentId}`;
  useEffect(() => {
    if (seededFor.current === seedKey) return;
    seededFor.current = seedKey;
    setRating(existing?.rating ?? 0);
    setText(existing?.reviewDescription ?? "");
    setAnonymous(existing?.isAnonymous ?? false);
  }, [seedKey, existing]);

  const save = useMutation({
    mutationFn: async () => {
      // Explicit null when cleared, never undefined: UpdateReviewSchema is
      // `.partial()`, so undefined means "leave it alone" and a consultee
      // deleting their written review could never actually delete it.
      const body = {
        rating,
        reviewDescription: text.trim() || null,
        isAnonymous: anonymous,
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
    onSuccess: async () => {
      toast({
        title: existing ? "Review updated" : "Thanks for your review",
        description: "It appears on the expert's public profile.",
      });
      // AWAITED: until this resolves, `existing` is still null and the button
      // still reads "Post review", so a second press would POST again and take
      // a 409 off the one-review-per-session unique. `isPending` stays true for
      // the duration, which is what keeps the button disabled.
      await qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) => {
      toast({
        title: "Review",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  // A failed eligibility check is NOT the same as "you cannot review this".
  // Rendering nothing for both is the mistake the Platform tab already made
  // once — it showed a load failure as an empty list and invited the user to
  // file a request they already had open.
  if (isError) {
    return (
      <section className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t check whether you can review this session.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </section>
    );
  }
  // Still asking, or genuinely not eligible. Showing a disabled form to someone
  // who may never be allowed to use it is worse than showing nothing.
  if (isLoading || !session) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      {/* Named for the person, because that is who the user thinks they are
          reviewing and whose profile it lands on. The session is provenance —
          it proves the review is genuine and it is what let them in here — so
          it sits underneath as context rather than as the subject. */}
      <h3 className="text-sm font-medium text-foreground">
        {existing ? "Your review of " : "Review "}
        {session.consultantName ?? "this expert"}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {session.title}
        {" · "}
        Public — it appears on their profile with the date. One review per
        expert; you can edit it after a later session.
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

      <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
        />
        {/* Authenticity never depended on the name: the review is welded to a
            paid, attended session either way. Hiding it costs no trust and
            buys candour from someone who may want to book this person again. */}
        <span>
          Post as <strong>Verified client</strong> instead of my name
        </span>
      </label>

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
