"use client";

import { motion } from "framer-motion";
import { Quote, Star } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { TPublicConsultantReview } from "@/types/review";
import { TRUST_BADGES } from "./data";

function TestimonialCard({
  review,
  index,
}: Readonly<{
  review: TPublicConsultantReview;
  index: number;
}>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      viewport={{ once: true }}
      className="flex flex-col justify-between rounded-2xl border border-white/[0.08] bg-zinc-900/60 p-6"
    >
      <div>
        <div className="flex items-center gap-1 mb-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={`w-4 h-4 ${
                i < review.rating
                  ? "fill-white text-white"
                  : "fill-zinc-700 text-zinc-700"
              }`}
            />
          ))}
        </div>
        <p className="text-sm text-zinc-300 mb-6 leading-relaxed line-clamp-5">
          &ldquo;
          {review.reviewDescription ||
            "Great experience working with this expert!"}
          &rdquo;
        </p>
      </div>

      <div className="flex items-center gap-3 pt-4 border-t border-white/[0.06]">
        <Avatar className="w-9 h-9 border border-zinc-700 shrink-0">
          <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
          <AvatarFallback className="bg-zinc-800 text-zinc-300 text-xs font-medium">
            {review.consulteeProfile?.user?.name?.charAt(0) ?? "U"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="font-medium text-white text-sm truncate">
            {review.consulteeProfile?.user?.name || "Verified Participant"}
          </p>
          <p className="text-xs text-zinc-400 truncate">
            Session with {review.consultantProfile?.user?.name || "Expert"}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

interface TestimonialsSectionProps {
  reviews: TPublicConsultantReview[];
  isLoading: boolean;
}

export function TestimonialsSection({
  reviews,
  isLoading,
}: Readonly<TestimonialsSectionProps>) {
  // Deduplicate by id and take up to 6 unique reviews for a clean static grid
  const uniqueReviews = Array.from(
    new Map(reviews.map((r) => [r.id, r])).values(),
  );
  const displayReviews = uniqueReviews.slice(0, 6);
  const featuredReview = displayReviews[0];
  const gridReviews =
    displayReviews.length > 3 ? displayReviews.slice(1) : displayReviews;

  return (
    <section className="py-20 md:py-28 bg-zinc-950 text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-14"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">
            Verified Session Reviews
          </p>
          <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Trusted by ambitious <span className="text-zinc-400">learners</span>
          </h2>
          <p className="text-base md:text-lg text-zinc-400 leading-relaxed">
            Every rating and review on Familiarise comes from a completed,
            verified session on the platform.
          </p>
        </motion.div>

        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 mb-14">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-[220px] rounded-2xl border border-white/[0.08] bg-zinc-900/50 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <>
            {/* Featured Highlight Quote when we have enough reviews */}
            {featuredReview && displayReviews.length > 3 && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45 }}
                viewport={{ once: true }}
                className="rounded-2xl border border-white/10 bg-zinc-900/80 p-6 md:p-8 mb-6 flex flex-col md:flex-row md:items-center justify-between gap-6"
              >
                <div className="max-w-3xl">
                  <div className="flex items-center gap-2 mb-3">
                    <Quote className="w-5 h-5 text-zinc-400" />
                    <div className="flex items-center gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`w-3.5 h-3.5 ${
                            i < featuredReview.rating
                              ? "fill-white text-white"
                              : "fill-zinc-700 text-zinc-700"
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <p className="text-base md:text-lg text-zinc-200 leading-relaxed font-medium">
                    &ldquo;
                    {featuredReview.reviewDescription ||
                      "Great experience working with this expert!"}
                    &rdquo;
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0 md:border-l md:border-white/10 md:pl-6">
                  <Avatar className="w-11 h-11 border border-zinc-700">
                    <AvatarImage
                      src={featuredReview.consulteeProfile?.user?.image ?? ""}
                    />
                    <AvatarFallback className="bg-zinc-800 text-zinc-300 text-sm">
                      {featuredReview.consulteeProfile?.user?.name?.charAt(0) ??
                        "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold text-white text-sm">
                      {featuredReview.consulteeProfile?.user?.name ||
                        "Verified Participant"}
                    </p>
                    <p className="text-xs text-zinc-400">
                      Session with{" "}
                      {featuredReview.consultantProfile?.user?.name || "Expert"}
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Static 3-Column Review Grid */}
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 mb-14">
              {gridReviews.slice(0, 6).map((review, idx) => (
                <TestimonialCard
                  key={review.id}
                  review={review}
                  index={idx}
                />
              ))}
            </div>
          </>
        )}

        {/* Integrated Trust & Guarantees Strip */}
        <div className="pt-12 border-t border-white/[0.08] grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {TRUST_BADGES.map((badge) => {
            const Icon = badge.icon;
            return (
              <div
                key={badge.label}
                className="flex items-start gap-3.5 rounded-xl border border-white/[0.06] bg-zinc-900/30 p-4"
              >
                <div className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0">
                  <Icon className="w-4 h-4 text-zinc-300" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white mb-0.5">
                    {badge.label}
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    {badge.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
