import { Section } from "@/components/dashboard/Section";
import { formatInViewerZone, type ViewerZone } from "@/lib/time/viewer-zone";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

import { ArrowLink } from "./ArrowLink";
import { excerptOf } from "./home-model";

/** The newest learner review with text; nothing at all until one exists. */
export function LatestFeedback({
  review,
  consultantId,
  viewerZone,
}: Readonly<{
  review: TConsultantDashboardResponse["latestReview"];
  consultantId: string;
  viewerZone: ViewerZone;
}>) {
  if (!review) return null;
  return (
    <Section title="Latest feedback">
      <figure className="rounded-xl border border-border bg-card p-4 shadow-elevation-1">
        <blockquote className="text-sm text-foreground">
          &ldquo;{excerptOf(review.body)}&rdquo;
        </blockquote>
        <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            {review.rating} out of 5 from{" "}
            {review.reviewerFirstName ?? "a learner"} ·{" "}
            {formatInViewerZone(
              review.createdAt,
              viewerZone.zone,
              "d MMM yyyy",
            )}
          </span>
          <ArrowLink href={`/dashboard/consultant/${consultantId}/reviews`}>
            Reviews
          </ArrowLink>
        </figcaption>
      </figure>
    </Section>
  );
}
