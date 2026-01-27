"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { TConsultantProfile } from "@/types/consultant";

const ExpertCard = memo(function ExpertCard({
  expert,
}: {
  expert: TConsultantProfile;
}) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="block flex-shrink-0 w-[300px] mx-3"
    >
      <Card className="h-full border border-zinc-200 bg-white overflow-hidden group hover:border-zinc-300 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl">
        <CardContent className="p-6">
          <div className="flex items-center gap-4 mb-4">
            <Avatar className="w-16 h-16 border-2 border-zinc-100 shadow-md">
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
              />
              <AvatarFallback className="bg-gradient-to-br from-zinc-700 to-zinc-900 text-white text-lg font-medium">
                {expert.user.name?.charAt(0) ?? "E"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-zinc-900 truncate">
                {expert.user.name}
              </h4>
              <p className="text-sm text-zinc-500 truncate">
                {expert.headline || expert.domain.name}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-4">
            <div className="flex items-center gap-1">
              <Star className="w-4 h-4 fill-zinc-800 text-zinc-800" />
              <span className="font-medium text-zinc-900">
                {expert.rating.toFixed(1)}
              </span>
            </div>
            <span className="text-zinc-300">•</span>
            <span className="text-sm text-zinc-500">{expert.experience}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            {expert.tags?.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200 text-xs border-0"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

const ExpertLoadingSkeleton = memo(function ExpertLoadingSkeleton() {
  return (
    <div className="flex-shrink-0 w-[300px] mx-3">
      <Card className="h-[200px] animate-pulse bg-zinc-100 border-0" />
    </div>
  );
});

interface FeaturedExpertsSectionProps {
  experts: TConsultantProfile[];
  isLoading: boolean;
}

export function FeaturedExpertsSection({
  experts,
  isLoading,
}: FeaturedExpertsSectionProps) {
  return (
    <section className="py-20 md:py-32 bg-white overflow-hidden relative">
      <div className="absolute inset-0 dot-pattern-light opacity-60" />

      <div className="container mx-auto px-4 md:px-6 mb-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="flex flex-col md:flex-row md:items-end md:justify-between gap-6"
        >
          <div>
            <Badge
              variant="secondary"
              className="mb-4 bg-zinc-100 text-zinc-700 hover:bg-zinc-100 border-0"
            >
              Featured Experts
            </Badge>
            <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-zinc-900 mb-2">
              Learn from <span className="text-zinc-500">industry leaders</span>
            </h2>
            <p className="text-lg text-zinc-600">
              Handpicked professionals ready to guide your journey
            </p>
          </div>
          <Link href="/explore/experts">
            <Button
              variant="outline"
              className="group border-zinc-300 hover:bg-zinc-100"
            >
              View All Experts
              <ChevronRight className="ml-1 w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </Link>
        </motion.div>
      </div>

      {/* Marquee */}
      <div className="relative">
        <div className="absolute left-0 top-0 bottom-0 w-32 bg-gradient-to-r from-white to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-32 bg-gradient-to-l from-white to-transparent z-10" />

        <div className="flex animate-marquee">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <ExpertLoadingSkeleton key={i} />
            ))
          ) : (
            <>
              {[...experts, ...experts].map((expert, i) => (
                <ExpertCard key={`${expert.id}-${i}`} expert={expert} />
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
