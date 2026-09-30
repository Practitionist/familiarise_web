"use client";

import { BadgeCheck, Star, MessageSquare } from "lucide-react";
import type {
  TPublicConsultantReview,
  TReviewTrackPresence,
} from "@/types/review";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: TPublicConsultantReview[];
  /** Which tracks hold any live review — from its own query, because
   *  `reviews` is a 20-row page and a track can exist entirely outside it. */
  reviewTracks: TReviewTrackPresence;
  /**
   * #705 — the published score, or null when too few sessions have been rated
   * to publish one. Passed in rather than derived here: this list is a `take`
   * page, so averaging it disagreed with the profile's own number for anyone
   * with more reviews than the page size, and it counted a 200-seat webinar's
   * attendees as 200 data points.
   */
  reviewCount: number;
  /**
   * #1300 (ADR 29) — the two tracks, shown side by side rather than blended.
   * NULL on either means SUPPRESSED — below its own threshold — never zero, and
   * the two thresholds are independent, so an expert can be published on one and
   * withheld on the other.
   */
  publishedRatingOneToOne: number | null;
  publishedRatingGroup: number | null;
  ratedClientsOneToOne: number;
  ratedEventsGroup: number;
  /** The per-user "may you review this expert" island. Rendered here because
   *  this is where the review lives and where you read the others. */
  composer?: React.ReactNode;
}

interface ReviewTrackSummary {
  label: string;
  score: number | null;
  count: number;
  unit: string;
  present: boolean;
}

function TrackStatPills({
  tracks,
  reviewCount,
}: Readonly<{
  tracks: ReviewTrackSummary[];
  reviewCount: number;
}>) {
  if (tracks.length === 0) {
    if (reviewCount > 0) {
      return (
        <p className="mt-3 text-sm text-muted-foreground">
          Not enough rated sessions yet to show an average
        </p>
      );
    }
    return null;
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5">
      {tracks.map((track) => (
        <div
          key={track.label}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-muted/50 px-3.5 py-2"
        >
          {track.score !== null ? (
            <>
              <Star className="w-4 h-4 fill-amber-400 text-amber-400 shrink-0" />
              <span className="text-sm font-semibold text-foreground">
                {track.score.toFixed(1)}
              </span>
              <span className="text-sm font-medium text-muted-foreground">
                {track.label}
              </span>
              <span className="text-xs text-muted-foreground/75">
                · {track.count} {track.unit}
              </span>
            </>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">
              Not enough rated {track.label} yet
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ReviewsSection({
  reviews,
  reviewTracks,
  reviewCount,
  publishedRatingOneToOne,
  publishedRatingGroup,
  ratedClientsOneToOne,
  ratedEventsGroup,
  composer,
}: Readonly<ReviewsSectionProps>) {
  // A track appears when this consultant demonstrably does that kind of work.
  //
  // The counts alone are not that test: they count QUALIFYING data points, so a
  // consultant who has run ten webinars that each drew two responses has
  // `ratedEventsGroup === 0` and would have looked like somebody who never runs
  // group sessions. `reviewTracks` is the honest signal, and it comes from the
  // data layer rather than from `reviews`, which is one page.
  //
  // Still filtered rather than always rendering both: telling a consultant who
  // has only ever done one-to-one work that they have "not enough rated group
  // sessions yet" implies they run them.
  const tracks: ReviewTrackSummary[] = [
    {
      label: "one-to-one",
      score: publishedRatingOneToOne,
      count: ratedClientsOneToOne,
      unit: "clients",
      present: reviewTracks.ONE_TO_ONE,
    },
    {
      label: "group sessions",
      score: publishedRatingGroup,
      count: ratedEventsGroup,
      unit: "events",
      present: reviewTracks.GROUP,
    },
  ].filter((t) => t.score !== null || t.count > 0 || t.present);

  // `id="reviews"` so the appointment page can deep-link here: the review
  // composer used to live there, and now only a link does.
  return (
    <div
      id="reviews"
      className="bg-card rounded-2xl border border-border p-6 md:p-8"
    >
      <div className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <MessageSquare className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground">
                Reviews ({reviewCount})
              </h3>
              <p className="text-xs text-muted-foreground">
                Submitted by learners after completed sessions
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-xs font-medium text-foreground">
            <BadgeCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            Verified session reviews
          </span>
        </div>

        {/* Two numbers, never one blend (ADR 29): each track shows its mean
            and count, or "not enough yet". */}
        <TrackStatPills tracks={tracks} reviewCount={reviewCount} />
      </div>

      {/* Header, the viewer's own form, the list: three flat siblings sharing
           one left edge. The island draws its own heading and the rule below it,
          because only it knows whether it rendered anything at all. */}
      {composer}

      <div className="space-y-3.5">
        {reviews && reviews.length > 0 ? (
          reviews.map((review) => <Review key={review.id} {...review} />)
        ) : (
          <div className="text-center py-10">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-muted-foreground/70" />
            </div>
            <p className="text-muted-foreground">No reviews yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              After a session with this expert, you can review them here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
