"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import {
  Star,
  MapPin,
  Briefcase,
  Clock,
  CheckCircle2,
  Globe,
  Github,
  Linkedin,
  Twitter,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SpotlightGrid } from "@/components/motion";
import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  reviewCount: number;
}

/**
 * Cinematic profile stage — a dark panel carrying the expert's identity while
 * the sections below stay on the light canvas. Purely presentational: every
 * value it shows comes in through props.
 */
export function ProfileHeader({
  userDetails,
  consultantDetails,
  reviewCount,
}: ProfileHeaderProps) {
  const socials: { label: string; icon: typeof Globe; href: string }[] = [
    userDetails.linkedinUrl && {
      label: "LinkedIn",
      icon: Linkedin,
      href: userDetails.linkedinUrl,
    },
    consultantDetails.twitterUrl && {
      label: "Twitter",
      icon: Twitter,
      href: consultantDetails.twitterUrl,
    },
    consultantDetails.githubUrl && {
      label: "GitHub",
      icon: Github,
      href: consultantDetails.githubUrl,
    },
    consultantDetails.websiteUrl && {
      label: "Website",
      icon: Globe,
      href: consultantDetails.websiteUrl,
    },
  ].filter(Boolean) as { label: string; icon: typeof Globe; href: string }[];

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-3xl border border-zinc-800/60 bg-zinc-950"
      aria-label={`${userDetails.name}'s profile`}
    >
      <SpotlightGrid className="opacity-40" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 right-0 h-64 w-[480px] rounded-full bg-zinc-500/10 blur-[110px]"
      />

      <div className="relative z-10 p-6 md:p-10">
        <div className="flex flex-col gap-7 sm:flex-row">
          {/* Portrait */}
          <div className="relative shrink-0">
            {userDetails.profileDisplayImage ? (
              <div className="relative h-32 w-32 overflow-hidden rounded-2xl ring-1 ring-white/20 md:h-44 md:w-44">
                <Image
                  src={userDetails.profileDisplayImage}
                  alt={userDetails.name || "Expert"}
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 128px, 176px"
                  priority
                />
              </div>
            ) : (
              <div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 text-4xl font-semibold text-white ring-1 ring-white/20 md:h-44 md:w-44 md:text-6xl">
                {userDetails.name?.charAt(0) || "E"}
              </div>
            )}
            {consultantDetails.isVerified && (
              <div className="absolute -bottom-2 -right-2 flex h-9 w-9 items-center justify-center rounded-full border-4 border-zinc-950 bg-emerald-500">
                <CheckCircle2 className="h-4 w-4 text-white" />
              </div>
            )}
          </div>

          {/* Identity */}
          <div className="min-w-0 flex-1">
            <h1 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-white text-balance">
              {userDetails.name}
            </h1>

            {/* Rating */}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-0.5">
                {[...Array(5)].map((_, i) => (
                  <Star
                    key={i}
                    className={`h-4 w-4 ${
                      i < Math.floor(consultantDetails.rating)
                        ? "fill-white text-white"
                        : "fill-zinc-700 text-zinc-700"
                    }`}
                  />
                ))}
              </div>
              <span className="font-semibold tabular-nums text-white">
                {consultantDetails.rating.toFixed(1)}
              </span>
              <span className="text-zinc-600">·</span>
              <span className="text-sm text-zinc-400">
                {reviewCount} reviews
              </span>
            </div>

            {/* Meta */}
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-400">
              <span className="inline-flex items-center gap-1.5">
                <Briefcase className="h-4 w-4 text-zinc-500" />
                {consultantDetails.domain.name}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-zinc-500" />
                {consultantDetails.experience} experience
              </span>
              {userDetails.timezone && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="h-4 w-4 text-zinc-500" />
                  {userDetails.timezone}
                </span>
              )}
            </div>

            {/* Tags */}
            {(consultantDetails.subDomains?.length ||
              consultantDetails.tags?.length) && (
              <div className="mt-5 flex flex-wrap gap-2">
                {consultantDetails.headline && (
                  <Badge className="rounded-full bg-white px-3 py-1 text-black hover:bg-white/90">
                    {consultantDetails.headline}
                  </Badge>
                )}
                {consultantDetails.subDomains?.map((subdomain) => (
                  <Badge
                    key={subdomain.id}
                    variant="outline"
                    className="rounded-full border-white/15 bg-transparent text-zinc-300 hover:bg-white/5"
                  >
                    {subdomain.name}
                  </Badge>
                ))}
                {consultantDetails.tags?.slice(0, 4).map((tag) => (
                  <Badge
                    key={tag.id}
                    className="rounded-full border-0 bg-white/[0.07] text-zinc-300 hover:bg-white/10"
                  >
                    {tag.name}
                  </Badge>
                ))}
              </div>
            )}

            {/* Socials */}
            {socials.length > 0 && (
              <div className="mt-6 flex flex-wrap gap-4 border-t border-white/[0.07] pt-5">
                {socials.map(({ label, icon: Icon, href }) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-white"
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.section>
  );
}
