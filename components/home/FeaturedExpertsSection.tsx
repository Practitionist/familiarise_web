"use client";

import { motion } from "framer-motion";
import { ChevronRight, Star } from "lucide-react";
import Link from "next/link";

import { MarqueeRow, TiltCard } from "@/components/motion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IConsultantCardData } from "@/types/consultant";

function ExpertCard({ expert }: { expert: IConsultantCardData }) {
  return (
    <TiltCard className="w-[300px] md:w-[320px]" maxTilt={5}>
      <Link
        href={`/explore/experts/${expert.id}`}
        className="block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        tabIndex={0}
      >
        <div className="card-lift flex h-full flex-col rounded-2xl border border-border bg-card p-6 shadow-card hover:border-foreground/30 hover:shadow-lift">
          <div className="mb-5 flex items-center gap-4">
            <Avatar className="h-16 w-16 border border-border">
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
              />
              <AvatarFallback className="bg-gradient-to-br from-zinc-700 to-zinc-900 text-lg font-medium text-white">
                {expert.user.name?.charAt(0) ?? "E"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h4 className="truncate font-semibold text-foreground">
                {expert.user.name}
              </h4>
              <p className="truncate text-sm text-muted-foreground">
                {expert.headline || expert.domain?.name}
              </p>
            </div>
          </div>

          <div className="mt-auto">
            <div className="mb-4 flex items-center gap-2 text-sm">
              <Star className="h-4 w-4 fill-foreground text-foreground" />
              <span className="font-medium tabular-nums text-foreground">
                {expert.rating.toFixed(1)}
              </span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground">{expert.experience}</span>
            </div>

            <div className="flex flex-wrap gap-2">
              {expert.tags?.slice(0, 3).map((tag) => (
                <Badge
                  key={tag.id}
                  variant="secondary"
                  className="rounded-full border-0 bg-secondary text-xs"
                >
                  {tag.name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </Link>
    </TiltCard>
  );
}

function ExpertLoadingSkeleton() {
  return (
    <div className="w-[300px] shrink-0 md:w-[320px]">
      <div className="h-[212px] animate-pulse rounded-2xl bg-muted" />
    </div>
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
  return (
    <section className="bg-background relative overflow-hidden py-20 md:py-28">
      <div className="container mx-auto mb-12 px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between"
        >
          <div>
            <Badge variant="secondary" className="mb-4 rounded-full border-0">
              Featured Experts
            </Badge>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
              Learn from{" "}
              <span className="text-muted-foreground">industry leaders</span>
            </h2>
            <p className="mt-3 max-w-md text-muted-foreground">
              Handpicked professionals ready to guide your journey.
            </p>
          </div>
          <Link href="/explore/experts">
            <Button variant="outline" className="group rounded-full">
              View All Experts
              <ChevronRight className="ml-1 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </Button>
          </Link>
        </motion.div>
      </div>

      {/* Pause on hover so cards stay readable and clickable; reduced-motion
          users get native scrolling via the globals.css override. */}
      <MarqueeRow duration={48} fadeEdges={false}>
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => (
              <ExpertLoadingSkeleton key={`skeleton-${i}`} />
            ))
          : experts.map((expert) => (
              <ExpertCard key={expert.id} expert={expert} />
            ))}
      </MarqueeRow>
    </section>
  );
}
