"use client";

import { Star, MessageSquare } from "lucide-react";
import { TPublicConsultantReview } from "@/types/review";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: TPublicConsultantReview[];
  /**
   * #705 — the published score, or null when too few sessions have been rated
   * to publish one. Passed in rather than derived here: this list is a `take`
   * page, so averaging it disagreed with the profile's own number for anyone
   * with more reviews than the page size, and it counted a 200-seat webinar's
   * attendees as 200 data points.
   *
   * Legacy single-track prop kept optional: this hotfix branch predates dev's
   * two-track (ADR 29) scores. When the dual props arrive via merge they take
   * precedence; otherwise the single score renders.
   */
  publishedRating?: number | null;
  reviewCount: number;
  /** ADR 29 dual tracks — optional until this branch catches up with dev. */
  publishedRatingOneToOne?: number | null;
  publishedRatingGroup?: number | null;
  ratedClientsOneToOne?: number;
  ratedEventsGroup?: number;
  reviewTracks?: { ONE_TO_ONE: boolean; GROUP: boolean };
  /** Per-user composer island (dev). Rendered when provided. */
  composer?: React.ReactNode;
}

export function ReviewsSection({
  reviews,
  publishedRating = null,
  reviewCount,
  publishedRatingOneToOne,
  publishedRatingGroup,
  ratedClientsOneToOne,
  ratedEventsGroup,
  reviewTracks,
  composer,
}: ReviewsSectionProps) {
  const hasDualTracks =
    publishedRatingOneToOne !== undefined ||
    publishedRatingGroup !== undefined;
  const tracks = hasDualTracks
    ? [
        {
          label: "one-to-one",
          score: publishedRatingOneToOne ?? null,
          count: ratedClientsOneToOne ?? 0,
          unit: "clients",
          present: reviewTracks?.ONE_TO_ONE ?? false,
        },
        {
          label: "group",
          score: publishedRatingGroup ?? null,
          count: ratedEventsGroup ?? 0,
          unit: "events",
          present: reviewTracks?.GROUP ?? false,
        },
      ].filter((t) => t.score !== null || t.count > 0 || t.present)
    : [];
  // `id="reviews"` so the appointment page can deep-link here.
  return (
    <div
      id="reviews"
      className="bg-card rounded-2xl border border-border p-6 md:p-8"
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Reviews ({reviewCount})
            </h3>
            {/* Compact score row + single trust caption replaces the old
                per-card "Reviewed on Familiarise" footers. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {hasDualTracks ? (
                tracks.length > 0 ? (
                  tracks.map((t) => (
                    <span key={t.label} className="flex items-center gap-1">
                      {t.score !== null ? (
                        <>
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                          <span className="text-sm font-medium text-foreground">
                            {t.score.toFixed(1)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t.label} · {t.count} {t.unit}
                          </span>
                        </>
                      ) : (
                        <span
                          className="text-xs text-muted-foreground"
                          title="Published once enough sessions have been rated"
                        >
                          {t.label} · not enough ratings yet
                        </span>
                      )}
                    </span>
                  ))
                ) : (
                  reviewCount > 0 && (
                    <span
                      className="text-xs text-muted-foreground"
                      title="Published once enough sessions have been rated"
                    >
                      Not enough ratings yet
                    </span>
                  )
                )
              ) : publishedRating !== null ? (
                <>
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  <span className="text-sm font-medium text-foreground">
                    {publishedRating.toFixed(1)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    average · {reviewCount}{" "}
                    {reviewCount === 1 ? "review" : "reviews"}
                  </span>
                </>
              ) : (
                reviewCount > 0 && (
                  <span
                    className="text-xs text-muted-foreground"
                    title="Published once enough sessions have been rated"
                  >
                    Not enough ratings yet
                  </span>
                )
              )}
            </div>
            {reviewCount > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                From paid, attended sessions
              </p>
            )}
          </div>
        </div>
      </div>

      {composer}

      <div className="space-y-4">
        {reviews && reviews.length > 0 ? (
          reviews.map((review) => <Review key={review.id} {...review} />)
        ) : (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-muted-foreground/70" />
            </div>
            <p className="text-muted-foreground">No reviews yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              After a session with this expert, you can review it from the
              session&apos;s page.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
