"use client";

import { ArrowRight, BadgeCheck, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { IConsultantCardData } from "@/types/consultant";
import { cn } from "@/utils/tailwind";
import {
  Em,
  Reveal,
  Section,
  SectionHeading,
  surface,
  surfaceInteractive,
} from "./primitives";

/** Enough for two full rows at the widest breakpoint. */
const MAX_EXPERTS = 8;

function ExpertCard({ expert }: { expert: IConsultantCardData }) {
  const subtitle = expert.headline || expert.domain?.name;
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className={cn(surface, surfaceInteractive, "group flex h-full flex-col p-6")}
    >
      <Avatar className="h-14 w-14 border border-white/10">
        <AvatarImage
          src={expert.user.image ?? "/placeholder-user.jpg"}
          alt={expert.user.name ?? "Expert"}
          className="object-cover"
        />
        <AvatarFallback className="bg-zinc-800 text-base text-zinc-200">
          {expert.user.name?.charAt(0) ?? "E"}
        </AvatarFallback>
      </Avatar>

      <div className="mt-5 flex items-center gap-1.5">
        <h3 className="truncate font-medium text-white">{expert.user.name}</h3>
        {expert.isVerified && (
          <BadgeCheck
            aria-label="Verified"
            className="h-4 w-4 shrink-0 text-zinc-300"
          />
        )}
      </div>
      {subtitle && (
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-400">
          {subtitle}
        </p>
      )}

      <div className="mt-auto flex items-center gap-3 pt-5 text-xs text-zinc-400">
        {expert.rating !== null && (
          <span className="inline-flex items-center gap-1 text-zinc-200">
            <Star className="h-3.5 w-3.5 fill-current" />
            {expert.rating.toFixed(1)}
          </span>
        )}
        {expert.rating !== null && expert.experience !== null && (
          <span aria-hidden className="h-3 w-px bg-white/10" />
        )}
        {expert.experience !== null && (
          <span>{expert.experience}+ yrs experience</span>
        )}
      </div>

      {expert.tags && expert.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {expert.tags.slice(0, 2).map((tag) => (
            <span
              key={tag.id}
              className="rounded-full border border-white/[0.08] px-2.5 py-0.5 text-xs text-zinc-400"
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

export function FeaturedExpertsSection({
  experts,
}: {
  experts: IConsultantCardData[];
}) {
  return (
    <Section id="experts">
      <SectionHeading
        eyebrow="Featured experts"
        title={
          <>
            Learn from <Em>industry leaders</Em>
          </>
        }
        description="Handpicked practitioners, each reviewed by our team before they can take a booking."
        action={
          <Link
            href="/explore/experts"
            className="group inline-flex items-center gap-1.5 text-sm text-zinc-300 transition-colors hover:text-white"
          >
            View all experts
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        }
      />

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {experts.slice(0, MAX_EXPERTS).map((expert, i) => (
          <Reveal as="li" key={expert.id} delay={(i % 4) * 0.05}>
            <ExpertCard expert={expert} />
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}
