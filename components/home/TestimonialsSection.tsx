"use client";

import { useMemo } from "react";
import { Star } from "lucide-react";

import { MarqueeRow, Reveal } from "@/components/motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { ReviewWithProfiles } from "@/types/review";

function TestimonialCard({ review }: { review: ReviewWithProfiles }) {
  return (
    <figure className="flex w-[340px] shrink-0 flex-col rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6 backdrop-blur-sm transition-colors duration-500 hover:border-white/20 md:w-[380px]">
      <div className="mb-4 flex items-center gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={`h-3.5 w-3.5 ${
              i < review.rating ? "fill-white text-white" : "fill-zinc-800 text-zinc-800"
            }`}
          />
        ))}
      </div>
      <blockquote className="mb-6 line-clamp-4 leading-relaxed text-zinc-300">
        &ldquo;
        {review.reviewDescription ||
          "Great experience working with this expert!"}
        &rdquo;
      </blockquote>
      <figcaption className="mt-auto flex items-center gap-3">
        <Avatar className="h-9 w-9 border border-zinc-700">
          <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
          <AvatarFallback className="bg-zinc-800 text-sm text-zinc-300">
            {review.consulteeProfile?.user?.name?.charAt(0) ?? "U"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {review.consulteeProfile?.user?.name || "Anonymous"}
          </p>
          <p className="truncate text-xs text-zinc-500">
            Session with {review.consultantProfile?.user?.name}
          </p>
        </div>
      </figcaption>
    </figure>
  );
}

function TestimonialLoadingSkeleton() {
  return <div className="h-[196px] w-[340px] shrink-0 animate-pulse rounded-2xl bg-zinc-800/70 md:w-[380px]" />;
}

interface TestimonialsSectionProps {
  reviews: ReviewWithProfiles[];
  isLoading: boolean;
}

export function TestimonialsSection({
  reviews,
  isLoading,
}: TestimonialsSectionProps) {
  // Ensure enough items for smooth marquee
  const displayReviews = useMemo(
    () =>
      reviews.length >= 3 ? reviews : [...reviews, ...reviews, ...reviews],
    [reviews],
  );

  const skeletons = (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <TestimonialLoadingSkeleton key={`ts-${i}`} />
      ))}
    </>
  );

  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-black via-zinc-950 to-black py-20 md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-zinc-500/[0.07] blur-[140px]"
      />

      <div className="container relative z-10 mx-auto mb-12 px-4 md:px-6">
        <Reveal className="text-center">
          <Badge
            variant="secondary"
            className="mb-4 rounded-full border-zinc-800 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800"
          >
            Testimonials
          </Badge>
          <h2 className="text-fluid-4xl font-bold tracking-tight text-white text-balance">
            Trusted by professionals{" "}
            <span className="silver-text">worldwide</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-zinc-500">
            Real stories from real sessions.
          </p>
        </Reveal>
      </div>

      {/* Two counter-drifting rows; both pause on hover for readability */}
      <div className="relative z-10 space-y-5">
        <MarqueeRow duration={56} fadeEdges={false}>
          {isLoading ? skeletons : displayReviews.map((r) => (
            <TestimonialCard key={`ltr-${r.id}`} review={r} />
          ))}
        </MarqueeRow>
        <MarqueeRow duration={64} reverse fadeEdges={false}>
          {isLoading
            ? skeletons
            : [...displayReviews].reverse().map((r) => (
                <TestimonialCard key={`rtl-${r.id}`} review={r} />
              ))}
        </MarqueeRow>
      </div>
    </section>
  );
}
