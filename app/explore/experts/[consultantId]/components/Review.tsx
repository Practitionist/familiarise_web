import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TPublicConsultantReview } from "@/types/review";
import { StarIcon } from "lucide-react";
import React from "react";

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
    <article className="py-5 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3.5">
        <Avatar className="h-9 w-9 shrink-0">
          {reviewerImage && (
            <AvatarImage src={reviewerImage} alt={reviewerName} />
          )}
          <AvatarFallback>
            {reviewerName.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div>
              <h4 className="text-sm font-semibold text-foreground">
                {reviewerName}
              </h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {new Date(createdAt).toLocaleDateString("en-IN")}
                {/* #1300 — BIS IS 19000:2022 asks that an edited review be shown as
                  edited. Every edit is marked, deliberately: making the mark
                  conditional on the expert having replied would hand them a
                  switch, since replying to everything would brand every
                  subsequent revision. */}
                {editedAt && <span className="ml-1.5">· Edited</span>}
              </p>
            </div>
            <span
              aria-label={`${rating} out of 5 stars`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-foreground"
            >
              <StarIcon
                aria-hidden="true"
                className="h-3.5 w-3.5 fill-amber-500 text-amber-500"
              />
              {rating}
              <span className="font-normal text-muted-foreground">/ 5</span>
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-foreground/80">
            {reviewDescription}
          </p>
          {/* #1300 — the expert's right of reply. `sanitisePublicReview` has already
            dropped the body if staff removed the reply, so a present body here is
            one that is meant to be read. A public review of a named professional
            with no way to answer it is the shape every benchmarked platform has
            moved away from. */}
          {replyBody && (
            <div className="mt-4 border-l-2 border-border pl-4">
              <p className="text-xs font-medium text-foreground">
                {consultantName
                  ? `Reply from ${consultantName}`
                  : "Response from the expert"}
                {repliedAt && (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    · {new Date(repliedAt).toLocaleDateString("en-IN")}
                  </span>
                )}
              </p>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {replyBody}
              </p>
            </div>
          )}
        </div>
      </div>
    </article>
  );
};

export default Review;
