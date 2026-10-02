import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TPublicConsultantReview } from "@/types/review";
import { BadgeCheck, StarIcon } from "lucide-react";
import React from "react";

const STAR_POSITIONS = [1, 2, 3, 4, 5] as const;

function formatReviewDate(dateValue: string | Date): string {
  return new Date(dateValue).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const Review: React.FC<Readonly<TPublicConsultantReview>> = ({
  consulteeProfile,
  consultantProfile,
  createdAt,
  rating,
  reviewDescription,
  editedAt,
  replyBody,
  repliedAt,
}) => {
  // "Verified client" rather than "Anonymous": the trust here comes from the
  // review being welded to a paid, attended session, and that is worth saying
  // out loud when the name is withheld. The server has already removed the
  // name — this is the label for that, not the mechanism.
  const reviewerName = consulteeProfile?.user?.name || "Verified client";
  const reviewerImage = consulteeProfile?.user?.image || null;
  const consultantName = consultantProfile?.user?.name || null;

  return (
    <div className="flex items-start gap-4 rounded-2xl border border-border/80 bg-card p-5 shadow-2xs transition-colors hover:border-border">
      <Avatar className="w-10 h-10 shrink-0 ring-1 ring-border">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback className="bg-muted text-foreground font-medium">
          {reviewerName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-2 mb-2.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-foreground">
                {reviewerName}
              </h4>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <BadgeCheck className="h-3 w-3 shrink-0" />
                Verified session
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatReviewDate(createdAt)}
              {/* #1300 — BIS IS 19000:2022 asks that an edited review be shown as
                  edited. Every edit is marked, deliberately: making the mark
                  conditional on the expert having replied would hand them a
                  switch, since replying to everything would brand every
                  subsequent revision. */}
              {editedAt && <span className="ml-1.5">· Edited</span>}
            </p>
          </div>
          <div
            className="flex items-center gap-0.5"
            aria-label={`${rating} out of 5 stars`}
          >
            {STAR_POSITIONS.map((starPos) => (
              <StarIcon
                key={`star-${rating}-${starPos}`}
                className={`w-4 h-4 ${
                  starPos <= rating
                    ? "fill-amber-400 text-amber-400"
                    : "fill-muted text-muted-foreground/25"
                }`}
              />
            ))}
          </div>
        </div>
        <p className="text-sm text-foreground/90 leading-relaxed">
          {reviewDescription}
        </p>
        {/* #1300 — the expert's right of reply. `sanitisePublicReview` has already
            dropped the body if staff removed the reply, so a present body here is
            one that is meant to be read. A public review of a named professional
            with no way to answer it is the shape every benchmarked platform has
            moved away from. */}
        {replyBody && (
          <div className="mt-4 rounded-xl bg-muted/50 border-l-2 border-primary/40 px-4 py-3">
            <p className="text-xs font-semibold text-foreground">
              {consultantName
                ? `Reply from ${consultantName}`
                : "Response from the expert"}
              {repliedAt && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {formatReviewDate(repliedAt)}
                </span>
              )}
            </p>
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
              {replyBody}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Review;
