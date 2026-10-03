"use client";

import { Star } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { TPublicConsultantReview } from "@/types/review";
import { cn } from "@/utils/tailwind";
import { Em, Reveal, Section, SectionHeading, surface } from "./primitives";

/** One featured quote plus a short wall — enough to read, not to scroll past. */
const MAX_WALL = 6;

function Reviewer({ review }: { review: TPublicConsultantReview }) {
  const name = review.consulteeProfile?.user?.name || "Anonymous";
  return (
    <div className="flex items-center gap-3">
      <Avatar className="h-9 w-9 border border-white/10">
        <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} alt="" />
        <AvatarFallback className="bg-zinc-800 text-xs text-zinc-300">
          {name.charAt(0)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{name}</p>
        {review.consultantProfile?.user?.name && (
          <p className="truncate text-xs text-zinc-500">
            Session with {review.consultantProfile.user.name}
          </p>
        )}
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <div
      className="flex items-center gap-0.5"
      aria-label={`${rating} out of 5 stars`}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          aria-hidden
          className={cn(
            "h-3.5 w-3.5",
            i < rating ? "fill-white text-white" : "fill-zinc-800 text-zinc-800",
          )}
        />
      ))}
    </div>
  );
}

/**
 * The page's single testimonial block. It used to be three: two marquee rows,
 * a "What our users say" column, and a block of hard-coded quotes. Only real,
 * published reviews appear here.
 */
export function TestimonialsSection({
  reviews,
}: {
  reviews: TPublicConsultantReview[];
}) {
  const withText = reviews.filter((r) => r.reviewDescription?.trim());
  const [featured, ...rest] = withText.length > 0 ? withText : reviews;
  if (!featured) return null;
  const wall = rest.slice(0, MAX_WALL);

  return (
    <Section id="testimonials">
      <SectionHeading
        eyebrow="Testimonials"
        title={
          <>
            Loved by <Em>professionals</Em>
          </>
        }
        description="Ratings and reviews come only from verified session participants."
      />

      <Reveal
        className={cn(
          surface,
          "relative overflow-hidden p-8 md:p-12",
          "bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.06),transparent_60%)]",
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute -top-6 right-8 font-serif text-[12rem] leading-none text-white/[0.04]"
        >
          &rdquo;
        </span>
        <Stars rating={featured.rating} />
        <blockquote className="mt-6 max-w-3xl font-serif text-2xl leading-snug text-white md:text-3xl">
          &ldquo;{featured.reviewDescription || "Great experience."}&rdquo;
        </blockquote>
        <div className="mt-8">
          <Reviewer review={featured} />
        </div>
      </Reveal>

      {wall.length > 0 && (
        <ul className="mt-4 columns-1 gap-4 md:columns-2 lg:columns-3">
          {wall.map((review, i) => (
            <Reveal
              as="li"
              key={review.id}
              delay={(i % 3) * 0.05}
              className={cn(surface, "mb-4 break-inside-avoid p-6")}
            >
              <Stars rating={review.rating} />
              <p className="mt-4 text-sm leading-relaxed text-zinc-300">
                &ldquo;{review.reviewDescription || "Great experience."}&rdquo;
              </p>
              <div className="mt-6">
                <Reviewer review={review} />
              </div>
            </Reveal>
          ))}
        </ul>
      )}
    </Section>
  );
}
