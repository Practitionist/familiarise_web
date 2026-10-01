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
}: Readonly<{
  expert: IConsultantCardData;
  index: number;
}>) {
  const companies =
    expert.user.workExperiences
      ?.map((w) => w.company)
      .filter(Boolean)
      .slice(0, 2) ?? [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05 }}
      viewport={{ once: true }}
    >
      <Link
        href={`/explore/experts/${expert.id}`}
        className="group flex flex-col justify-between h-full rounded-2xl border border-border bg-card p-6 shadow-elevation-1 hover:border-foreground/30 hover:shadow-elevation-2 transition-all duration-200"
      >
        <div>
          <div className="flex items-start gap-3.5 mb-4">
            <Avatar className="w-14 h-14 border border-border shrink-0">
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
              />
              <AvatarFallback className="bg-zinc-900 text-white text-base font-semibold">
                {expert.user.name?.charAt(0) ?? "E"}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-semibold text-foreground truncate">
                  {expert.user.name}
                </h3>
                {expert.isVerified && (
                  <BadgeCheck className="w-4 h-4 text-foreground shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 leading-relaxed">
                {expert.headline || expert.domain?.name || "Verified Expert"}
              </p>
            </div>
          </div>

          {/* Rating & Experience Meta */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mb-4">
            {expert.rating !== null && expert.rating > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <Star className="w-3.5 h-3.5 fill-foreground text-foreground" />
                {expert.rating.toFixed(1)}
                {expert.reviewCount ? (
                  <span className="text-muted-foreground font-normal">
                    ({expert.reviewCount})
                  </span>
                ) : null}
              </span>
            )}
            {expert.experience !== null && expert.experience > 0 && (
              <>
                {expert.rating !== null && expert.rating > 0 && (
                  <span aria-hidden="true">•</span>
                )}
                <span>{expert.experience}+ yrs exp</span>
              </>
            )}
            {expert.domain?.name && (
              <>
                {((expert.rating ?? 0) > 0 || (expert.experience ?? 0) > 0) && (
                  <span aria-hidden="true">•</span>
                )}
                <span className="truncate">{expert.domain.name}</span>
              </>
            )}
          </div>

          {/* Company background or skill tags */}
          {companies.length > 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
              <Briefcase className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{companies.join(" • ")}</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5 mb-5">
            {expert.tags?.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="bg-muted text-muted-foreground hover:bg-muted font-normal text-xs border-0"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between pt-3.5 border-t border-border text-xs font-medium text-foreground">
          <span>View profile &amp; availability</span>
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
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
}: Readonly<FeaturedExpertsSectionProps>) {
  const displayExperts = experts.slice(0, 8);

  return (
    <section className="py-20 md:py-28 bg-background border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-12">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              Featured Experts
            </p>
            <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-foreground tracking-tight mb-2">
              Learn from industry practitioners
            </h2>
            <p className="text-base text-muted-foreground max-w-2xl">
              Explore verified consultants available for 1-on-1 strategy calls,
              ongoing mentorship, and cohort programs.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            className="h-11 px-5 rounded-xl border-border hover:bg-muted shrink-0 self-start md:self-auto"
          >
            <Link href="/explore/experts">
              View All Experts
              <ArrowRight className="ml-2 w-4 h-4" />
            </Link>
          </Button>
        </div>

        {isLoading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[260px] rounded-2xl border border-border bg-muted/40 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {displayExperts.map((expert, idx) => (
              <ExpertCard key={expert.id} expert={expert} index={idx} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
