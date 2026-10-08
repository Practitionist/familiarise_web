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
import type { RatingCause } from "@prisma/client";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  bookingFeedbackKey,
  useSessionFeedback,
} from "@/hooks/useSessionFeedback";

const RATING_CAUSE_OPTIONS: readonly { value: RatingCause; label: string }[] = [
  { value: "CONSULTANT", label: "Expert quality" },
  { value: "PLATFORM_TECHNICAL", label: "Audio / video quality" },
  { value: "SCHEDULING", label: "Timing / scheduling" },
  { value: "CONTENT", label: "Session content" },
  { value: "PAYMENT", label: "Billing / pricing" },
  { value: "OTHER", label: "Other" },
];

export function SessionRatingRow({
  appointmentId,
  bookingAppointmentId,
  occurrenceId,
  existingRating,
  readOnly = false,
}: Readonly<{
  appointmentId: string;
  bookingAppointmentId: string;
  occurrenceId: string;
  existingRating: number | null;
  readOnly?: boolean;
}>) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const feedback = useSessionFeedback(bookingAppointmentId);
  const existingComment = feedback.comments[occurrenceId] ?? "";

  const [rating, setRating] = useState(existingRating ?? 0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState(existingComment);
  const [noteOpen, setNoteOpen] = useState(false);
  const [ratingCause, setRatingCause] = useState<RatingCause | null>(null);

  useEffect(() => {
    setRating(existingRating ?? 0);
    setRatingCause(null);
  }, [existingRating, occurrenceId]);

  useEffect(() => {
    setComment(existingComment);
  }, [existingComment, occurrenceId]);

  const save = useMutation({
    mutationFn: async (args: {
      value: number;
      note?: string;
      cause?: RatingCause;
    }) => {
      const trimmedNote = args.note?.trim();
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: args.value,
          occurrenceId,
          ...(trimmedNote !== undefined ? { comment: trimmedNote } : {}),
          ...(args.cause ? { ratingCause: args.cause } : {}),
        }),
      });
      if (!res.ok) await throwSupportError(res, "session rating");
      return res.json();
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({
        queryKey: bookingFeedbackKey(bookingAppointmentId),
      });
      if (variables.note !== undefined) {
        setNoteOpen(false);
        toast({
          title: "Private note saved",
          description:
            "Your written note is visible only to Familiarise support.",
        });
      }
    },
    onError: (e: unknown) => {
      setRating(existingRating ?? 0);
      toast({
        title: "Rating",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (readOnly && !existingRating) return null;

  if (readOnly) {
    return (
      <div
        className="flex items-center gap-0.5"
        title={`Rated ${existingRating} out of 5 by the attendee`}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={
              "h-3.5 w-3.5 " +
              (Math.round(existingRating ?? 0) >= n
                ? "fill-foreground text-foreground"
                : "text-muted-foreground/30")
            }
          />
        ))}
        <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">
          {existingRating}
        </span>
      </div>
    );
  }

  const DISCLOSURE =
    "Stars are shared with the expert; written notes are private to Familiarise.";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5" title={DISCLOSURE}>
          <span className="sr-only">{DISCLOSURE}</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              disabled={save.isPending}
              aria-label={`Rate ${n} out of 5. ${DISCLOSURE}`}
              aria-pressed={rating === n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={(e) => {
                e.stopPropagation();
                const previous = rating;
                const nextCause = n <= 3 ? ratingCause : null;
                setRating(n);
                setRatingCause(nextCause);
                save.mutate(
                  { value: n, cause: nextCause ?? undefined },
                  { onError: () => setRating(previous) },
                );
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

        {rating > 0 && !noteOpen && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNoteOpen(true);
            }}
            className="text-[11px] font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {existingComment ? "Edit private note" : "Add private note"}
          </button>
        )}
      </div>

      {rating > 0 && rating <= 3 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Main reason for rating"
        >
          {RATING_CAUSE_OPTIONS.map((option) => {
            const selected = ratingCause === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={save.isPending}
                aria-pressed={selected}
                onClick={(e) => {
                  e.stopPropagation();
                  const nextCause = selected ? null : option.value;
                  setRatingCause(nextCause);
                  save.mutate({
                    value: rating,
                    cause: nextCause ?? undefined,
                  });
                }}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  selected
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}

      {rating > 0 && noteOpen && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={comment}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Private note (only Familiarise sees this)"
            aria-label="Private feedback note (visible only to Familiarise)"
            className="h-7 min-w-[200px] flex-1 text-xs"
            maxLength={2000}
          />
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={save.isPending}
            onClick={(e) => {
              e.stopPropagation();
              save.mutate({
                value: rating,
                note: comment,
                cause: rating <= 3 && ratingCause ? ratingCause : undefined,
              });
            }}
          >
            {save.isPending ? "Saving…" : "Save note"}
          </Button>
        </div>
      )}

      {rating > 0 && !noteOpen && existingComment && (
        <p className="text-[11px] italic text-muted-foreground">
          Private note: &ldquo;{existingComment}&rdquo;
        </p>
      )}
    </div>
  );
}
