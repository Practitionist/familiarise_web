import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TPublicConsultantReview } from "@/types/review";

import { BadgeCheck, Star } from "lucide-react";
import React from "react";

// Forward-compatible props: this hotfix branch predates dev's reply /
// revision-trail fields, but the merged PR must not regress them. Optional
// extras render when present and are ignored when absent.
type ReviewProps = TPublicConsultantReview &
  Partial<{
    consultantProfile: { user: { name: string | null } | null } | null;
    editedAt: string | Date | null;
    replyBody: string | null;
    repliedAt: string | Date | null;
  }>;

function formatShortDate(value: string | Date): string {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const Review: React.FC<Readonly<ReviewProps>> = ({
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
  const isVerifiedFallback = !consulteeProfile?.user?.name;
  const reviewerImage = consulteeProfile?.user?.image || null;
  const consultantName =
    consultantProfile && "user" in consultantProfile
      ? (consultantProfile.user?.name ?? null)
      : null;

  return (
    <div className="flex items-start gap-3.5 rounded-2xl border border-border/60 bg-card p-5">
      <Avatar className="h-9 w-9 shrink-0">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback className="bg-muted text-sm font-medium text-muted-foreground">
          {reviewerName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <span className="truncate">{reviewerName}</span>
              {isVerifiedFallback && (
                <BadgeCheck
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label="Verified client"
                />
              )}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatShortDate(createdAt)}
              {/* #1300 — BIS IS 19000:2022 asks that an edited review be shown
                  as edited. Every edit is marked, deliberately: making the
                  mark conditional on the expert having replied would hand them
                  a switch. */}
              {editedAt && <span className="ml-1.5">· Edited</span>}
            </p>
          </div>
          <div
            className="flex shrink-0 items-center gap-0.5 pt-0.5"
            role="img"
            aria-label={`Rated ${rating} out of 5`}
          >
            {[...Array(5)].map((_, i) => (
              <Star
                key={`star-${rating}-${i}`}
                className={`h-3.5 w-3.5 ${
                  i < rating
                    ? "fill-amber-400 text-amber-400"
                    : "fill-muted text-muted"
                }`}
              />
            ))}
          </div>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">
          {reviewDescription}
        </p>
        {/* The expert's right of reply. `sanitisePublicReview` drops the body
            when staff remove it, so a present body is meant to be read. inset,
            not another divider: one surface, no double rules. */}
        {replyBody && (
          <div className="mt-3 rounded-xl bg-muted/50 px-3.5 py-3">
            <p className="text-xs font-medium text-foreground">
              {consultantName
                ? `Response from ${consultantName}`
                : "Response from the expert"}
              {repliedAt && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {formatShortDate(repliedAt)}
                </span>
              )}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-foreground/75">
              {replyBody}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Review;
