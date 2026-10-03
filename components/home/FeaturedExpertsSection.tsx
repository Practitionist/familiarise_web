"use client";

import { motion } from "framer-motion";
import { ArrowRight, BadgeCheck, Briefcase, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IConsultantCardData } from "@/types/consultant";

function ExpertCard({
  expert,
  index,
}: {
  expert: IConsultantCardData;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.06, 0.24) }}
      className="h-full"
    >
      <Link
        href={`/explore/experts/${expert.id}`}
        className="group flex h-full flex-col rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-elevation-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 md:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <Avatar className="h-16 w-16 border border-border shadow-elevation-1">
            <AvatarImage
              src={expert.user.image ?? "/placeholder-user.jpg"}
              alt={expert.user.name ?? "Expert"}
              className="object-cover"
            />
            <AvatarFallback className="bg-zinc-900 text-lg font-semibold text-white">
              {expert.user.name?.charAt(0) ?? "E"}
            </AvatarFallback>
          </Avatar>
          {expert.isVerified && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <BadgeCheck className="h-3.5 w-3.5 text-foreground" />
              Verified
            </span>
          )}
        </div>

        <div className="mt-5">
          <h3 className="flex items-center gap-1.5 text-lg font-bold text-foreground">
            <span className="line-clamp-1">{expert.user.name}</span>
          </h3>
          <p className="mt-1 line-clamp-2 min-h-10 text-sm leading-relaxed text-muted-foreground">
            {expert.headline || expert.domain?.name || "Familiarise expert"}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {expert.rating !== null && (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Star className="h-3.5 w-3.5 fill-foreground" />
              {expert.rating.toFixed(1)}
            </span>
          )}
          {expert.experience && (
            <span className="inline-flex items-center gap-1">
              <Briefcase className="h-3.5 w-3.5" />
              {expert.experience} years experience
            </span>
          )}
        </div>

        {expert.tags && expert.tags.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {expert.tags.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="border-0 bg-muted text-[11px] font-normal text-muted-foreground"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between border-t border-border pt-5 text-sm font-semibold text-foreground">
          View profile
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </div>
      </Link>
    </motion.div>
  );
}

interface FeaturedExpertsSectionProps {
  experts: IConsultantCardData[];
  isLoading: boolean;
}

export function FeaturedExpertsSection({
  experts,
  isLoading,
}: FeaturedExpertsSectionProps) {
  const visibleExperts = experts.slice(0, 4);

  return (
    <section className="relative overflow-hidden bg-zinc-100 py-20 dark:bg-zinc-950 md:py-28">
      <div className="dot-pattern-light pointer-events-none absolute inset-0 opacity-40 dark:opacity-10" />
      <div className="relative mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <div className="mb-10 flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Meet the experts
            </p>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
              Real experience, ready to share.
            </h2>
            <p className="mt-3 max-w-2xl text-fluid-base text-muted-foreground">
              Explore verified profiles, compare their focus areas, and choose
              the person who fits the problem in front of you.
            </p>
          </div>
          <Button asChild variant="outline" className="w-full md:w-auto">
            <Link href="/explore/experts">
              View all experts
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-80 animate-pulse rounded-2xl border border-border bg-muted"
                />
              ))
            : visibleExperts.map((expert, index) => (
                <ExpertCard key={expert.id} expert={expert} index={index} />
              ))}
        </div>
      </div>
    </section>
  );
}
