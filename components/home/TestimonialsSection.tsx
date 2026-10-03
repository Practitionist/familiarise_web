"use client";

import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { TPublicConsultantReview } from "@/types/review";

function TestimonialCard({
  review,
  index,
}: {
  review: TPublicConsultantReview;
  index: number;
}) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: index * 0.08 }}
      className="flex h-full flex-col rounded-2xl border border-border bg-card p-6 md:p-7"
    >
      <div className="flex items-center justify-between">
        <div
          className="flex items-center gap-1"
          aria-label={`${review.rating} out of 5 stars`}
        >
          {Array.from({ length: 5 }).map((_, star) => (
            <Star
              key={star}
              aria-hidden="true"
              className={`h-4 w-4 ${
                star < review.rating
                  ? "fill-foreground text-foreground"
                  : "fill-muted text-muted"
              }`}
            />
          ))}
        </div>
        <Quote className="h-6 w-6 text-muted-foreground/30" />
      </div>

      <blockquote className="my-7 line-clamp-6 text-fluid-base leading-relaxed text-foreground">
        “{review.reviewDescription}”
      </blockquote>

      <div className="mt-auto flex items-center gap-3 border-t border-border pt-5">
        <Avatar className="h-10 w-10 border border-border">
          <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
          <AvatarFallback className="bg-muted text-sm font-semibold text-muted-foreground">
            {review.consulteeProfile?.user?.name?.charAt(0) ?? "F"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {review.consulteeProfile?.user?.name || "Familiarise learner"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Session with {review.consultantProfile?.user?.name || "an expert"}
          </p>
        </div>
      </div>
    </motion.article>
  );
}

interface TestimonialsSectionProps {
  reviews: TPublicConsultantReview[];
  isLoading: boolean;
}

export function TestimonialsSection({
  reviews,
  isLoading,
}: TestimonialsSectionProps) {
  const visibleReviews = reviews.slice(0, 3);

  return (
    <section className="bg-background py-20 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45 }}
          className="mb-10 max-w-3xl"
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            From real sessions
          </p>
          <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
            Useful conversations leave a mark.
          </h2>
          <p className="mt-4 text-fluid-base leading-relaxed text-muted-foreground">
            Published feedback comes from people who actually met with an expert
            through Familiarise.
          </p>
        </motion.div>

        <div className="grid gap-4 md:grid-cols-3">
          {isLoading
            ? Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={index}
                  className="h-72 animate-pulse rounded-2xl bg-muted"
                />
              ))
            : visibleReviews.map((review, index) => (
                <TestimonialCard
                  key={review.id}
                  review={review}
                  index={index}
                />
              ))}
        </div>
      </div>
    </section>
  );
}
