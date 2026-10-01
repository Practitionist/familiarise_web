import { Quote, Star } from "lucide-react";
import Link from "next/link";
import type { TPublicConsultantReview } from "@/types/review";
import { nameInitials } from "@/lib/home/landing-content";
import { LandingContainer, SectionIntro } from "./LandingShared";

/** Blank reviews never turn into invented quotes, and anonymous identities stay absent. */
export function LandingReviews({
  reviews,
}: {
  reviews: TPublicConsultantReview[];
}) {
  const visibleReviews = reviews
    .filter((review) => review.reviewDescription?.trim())
    .slice(0, 3);
  if (!visibleReviews.length) return null;

  return (
    <section className="bg-[#f7f7f3] py-16 sm:py-20 lg:py-24">
      <LandingContainer>
        <SectionIntro
          eyebrow="In their own words"
          title="Small conversations. Meaningful perspectives."
          description="Read what people have shared about their sessions with Familiarise experts."
        />
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {visibleReviews.map((review) => {
            const name = review.isAnonymous
              ? "Anonymous"
              : review.consulteeProfile?.user?.name || "Anonymous";
            return (
              <figure
                key={review.id}
                className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 sm:p-7"
              >
                <div className="mb-6 flex items-center justify-between">
                  <Quote
                    className="size-6 text-zinc-400"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <span className="inline-flex items-center gap-1 text-xs text-zinc-700">
                    <Star className="size-3 fill-current" aria-hidden="true" />
                    {review.rating.toFixed(1)}
                    <span className="text-zinc-500">/ 5</span>
                  </span>
                </div>
                <blockquote className="flex-1 text-sm leading-relaxed text-zinc-800">
                  <p className="line-clamp-6">
                    &ldquo;{review.reviewDescription}&rdquo;
                  </p>
                </blockquote>
                {review.replyBody && (
                  <div className="mt-4 border-t border-zinc-100 pt-4 text-xs leading-relaxed text-zinc-600">
                    <p className="mb-1 font-medium text-zinc-900">
                      Expert response
                    </p>
                    <p className="line-clamp-3">{review.replyBody}</p>
                  </div>
                )}
                <figcaption className="mt-7 flex items-center gap-3 border-t border-zinc-100 pt-5">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f1f1eb] text-xs text-zinc-600"
                  >
                    {name === "Anonymous" ? "—" : nameInitials(name)}
                  </span>
                  <div>
                    <p className="text-xs font-medium text-zinc-900">{name}</p>
                    <p className="mt-1 text-[11px] text-zinc-500">
                      {review.consultantProfile?.user?.name
                        ? `Session with ${review.consultantProfile.user.name}`
                        : "Familiarise session"}
                      {review.editedAt ? " · Edited" : ""}
                    </p>
                  </div>
                </figcaption>
                <Link
                  href={`/explore/experts/${review.consultantProfileId}#reviews`}
                  className="mt-3 inline-flex min-h-11 items-center text-xs font-medium text-zinc-700 underline underline-offset-4"
                >
                  Read the full review
                </Link>
              </figure>
            );
          })}
        </div>
      </LandingContainer>
    </section>
  );
}
