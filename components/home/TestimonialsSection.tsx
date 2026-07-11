"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { ReviewWithProfiles } from "@/types/review";
import { TRUST_BADGES } from "./data";

function TestimonialCard({ review }: { review: ReviewWithProfiles }) {
  return (
    <Card className="w-[350px] flex-shrink-0 mx-3 border border-zinc-800 bg-zinc-900/50 backdrop-blur-sm">
      <CardContent className="p-6">
        <div className="flex items-center gap-1 mb-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={`w-4 h-4 ${i < review.rating ? "fill-amber-400 text-amber-400" : "fill-zinc-700 text-zinc-700"}`}
            />
          ))}
        </div>
        <p className="text-zinc-300 mb-6 line-clamp-4 leading-relaxed">
          &ldquo;
          {review.reviewDescription ||
            "Great experience working with this expert!"}
          &rdquo;
        </p>
        <div className="flex items-center gap-3">
          <Avatar className="w-10 h-10 border border-zinc-700">
            <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
            <AvatarFallback className="bg-zinc-800 text-zinc-300 text-sm">
              {review.consulteeProfile?.user?.name?.charAt(0) ?? "U"}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-white text-sm">
              {review.consulteeProfile?.user?.name || "Anonymous"}
            </p>
            <p className="text-xs text-zinc-500">
              Session with {review.consultantProfile?.user?.name}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TestimonialLoadingSkeleton() {
  return (
    <div className="flex-shrink-0 w-[350px] mx-3">
      <Card className="h-[200px] animate-pulse bg-zinc-800 border-0" />
    </div>
  );
}

// Real review + real avatar only — no stock portraits on testimonials.
function FeaturedQuote({ review }: { review: ReviewWithProfiles }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      viewport={{ once: true }}
      className="max-w-3xl mx-auto text-center mb-16 relative"
    >
      <Quote className="w-10 h-10 text-zinc-700 mx-auto mb-6" />
      <blockquote className="text-xl md:text-2xl text-zinc-200 leading-relaxed font-medium mb-8">
        &ldquo;{review.reviewDescription}&rdquo;
      </blockquote>
      <div className="flex items-center justify-center gap-3">
        <Avatar className="w-12 h-12 border border-zinc-700">
          <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
          <AvatarFallback className="bg-zinc-800 text-zinc-300">
            {review.consulteeProfile?.user?.name?.charAt(0) ?? "U"}
          </AvatarFallback>
        </Avatar>
        <div className="text-left">
          <p className="font-medium text-white text-sm">
            {review.consulteeProfile?.user?.name || "Anonymous"}
          </p>
          <p className="text-xs text-zinc-500">
            Session with {review.consultantProfile?.user?.name}
          </p>
        </div>
      </div>
    </motion.div>
  );
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

  // Longest well-rated review carries the pull-quote.
  const featured = useMemo(
    () =>
      [...reviews]
        .filter((r) => r.rating >= 4 && r.reviewDescription)
        .sort(
          (a, b) =>
            (b.reviewDescription?.length ?? 0) -
            (a.reviewDescription?.length ?? 0),
        )[0] ?? null,
    [reviews],
  );

  return (
    <section className="py-24 md:py-32 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black overflow-hidden relative">
      <div className="absolute inset-0 grid-pattern opacity-20" />

      {/* Glow accents */}
      <div className="absolute top-1/2 left-0 w-96 h-96 bg-zinc-700/20 rounded-full blur-[150px] -translate-y-1/2" />
      <div className="absolute top-1/2 right-0 w-96 h-96 bg-zinc-600/15 rounded-full blur-[150px] -translate-y-1/2" />

      <div className="container mx-auto px-4 md:px-6 mb-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <Badge
            variant="secondary"
            className="mb-4 bg-zinc-800 text-zinc-300 hover:bg-zinc-800 border-zinc-700"
          >
            Testimonials
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Loved by <span className="text-zinc-400">professionals</span>
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            See what our community has to say about their experience
          </p>
        </motion.div>

        {featured && !isLoading && <FeaturedQuote review={featured} />}
      </div>

      {/* First marquee row - left to right */}
      <div className="relative mb-8">
        <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-zinc-950 to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-zinc-950 to-transparent z-10" />

        <div className="flex animate-marquee">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <TestimonialLoadingSkeleton key={i} />
            ))
          ) : (
            <>
              {[...displayReviews, ...displayReviews, ...displayReviews].map(
                (review, i) => (
                  <TestimonialCard
                    key={`ltr-${review.id}-${i}`}
                    review={review}
                  />
                ),
              )}
            </>
          )}
        </div>
      </div>

      {/* Second marquee row - right to left */}
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-zinc-950 to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-zinc-950 to-transparent z-10" />

        <div className="flex animate-marquee-reverse">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <TestimonialLoadingSkeleton key={i} />
            ))
          ) : (
            <>
              {[...displayReviews, ...displayReviews, ...displayReviews]
                .reverse()
                .map((review, i) => (
                  <TestimonialCard
                    key={`rtl-${review.id}-${i}`}
                    review={review}
                  />
                ))}
            </>
          )}
        </div>
      </div>

      {/* Trust badges — absorbed from the old TrustBadgesSection strip */}
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="mt-20 pt-12 border-t border-zinc-800/80 grid grid-cols-2 lg:grid-cols-4 gap-8"
        >
          {TRUST_BADGES.map((badge) => {
            const Icon = badge.icon;
            return (
              <div
                key={badge.label}
                className="flex flex-col items-center text-center gap-3"
              >
                <div className="w-12 h-12 rounded-full bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-zinc-300" />
                </div>
                <div>
                  <p className="text-white font-medium text-sm">
                    {badge.label}
                  </p>
                  <p className="text-zinc-500 text-xs mt-1">
                    {badge.description}
                  </p>
                </div>
              </div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
