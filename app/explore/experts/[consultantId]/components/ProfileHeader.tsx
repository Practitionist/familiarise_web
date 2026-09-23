"use client";

import Image from "next/image";
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
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@prisma/client";
import type { ConsultantDetailData } from "../types";
import { displayedScore, displayedScoreCount } from "@/lib/reviews-display";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: ConsultantDetailData;
  reviewCount: number;
}

export function ProfileHeader({
  userDetails,
  consultantDetails,
  reviewCount,
}: ProfileHeaderProps) {
  const headlineScore = displayedScore(consultantDetails);
  // #1566 — a published score is always shown with its own denominator; the total
  // review count is the wrong number beside a per-track mean.
  const headlineCount = displayedScoreCount(consultantDetails, "ONE_TO_ONE");
  return (
    <div className="rounded-3xl border border-border bg-card p-6 shadow-sm md:p-9">
      <div className="flex flex-col gap-7 sm:flex-row md:gap-9">
        {/* Profile Display Image - Square format */}
        <div className="relative flex-shrink-0">
          {userDetails.profileDisplayImage ? (
            <div className="relative h-36 w-36 overflow-hidden rounded-2xl ring-1 ring-border md:h-44 md:w-44">
              <Image
                src={userDetails.profileDisplayImage}
                alt={userDetails.name || "Expert"}
                fill
                className="object-cover"
              />
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute bottom-2 right-2 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-card">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </div>
          ) : (
            <>
              <Avatar className="h-32 w-32 ring-1 ring-border md:h-40 md:w-40">
                <AvatarImage
                  src={userDetails.image || "/placeholder-user.jpg"}
                  alt={userDetails.name || "Expert"}
                  className="object-cover"
                />
                <AvatarFallback className="text-2xl bg-primary text-primary-foreground">
                  {userDetails.name?.charAt(0) || "E"}
                </AvatarFallback>
              </Avatar>
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-card">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="mb-2">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Familiarise expert
            </p>
            <h1 className="text-fluid-4xl font-semibold tracking-tight text-foreground">
              {userDetails.name}
            </h1>
            {consultantDetails.headline && (
              <p className="mt-2 text-base leading-relaxed text-muted-foreground md:text-lg">
                {consultantDetails.headline}
              </p>
            )}
          </div>

          {/* Rating. #1300 — the published 1:1 score, no fallback (#1566), with
              "based on N clients"; the reviews section below lists both tracks.
              Null until five distinct clients have rated. */}
          <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
            {headlineScore.score !== null && (
              <>
                <Star
                  className="h-4 w-4 fill-amber-400 text-amber-400"
                  aria-hidden="true"
                />
                <span className="font-semibold text-foreground">
                  {headlineScore.score.toFixed(1)}
                </span>
                <span className="text-muted-foreground/70" aria-hidden="true">
                  ·
                </span>
              </>
            )}
            <span className="text-muted-foreground">
              {headlineScore.score !== null
                ? `based on ${headlineCount} client${headlineCount === 1 ? "" : "s"}`
                : `${reviewCount} reviews`}
            </span>
          </div>

          {/* Meta */}
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Briefcase className="w-4 h-4 text-muted-foreground/70" />
              <span>{consultantDetails.domain.name}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="w-4 h-4 text-muted-foreground/70" />
              <span>{consultantDetails.experience} experience</span>
            </div>
            {userDetails.timezone && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="w-4 h-4 text-muted-foreground/70" />
                <span>{userDetails.timezone}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-2 mt-4">
            {consultantDetails.subDomains?.map((subdomain) => (
              <Badge
                key={subdomain.id}
                variant="outline"
                className="border-border text-muted-foreground"
              >
                {subdomain.name}
              </Badge>
            ))}
            {consultantDetails.tags?.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                className="bg-muted text-muted-foreground hover:bg-muted/80"
              >
                {tag.name}
              </Badge>
            ))}
          </div>

          {/* Social Links */}
          {(userDetails.linkedinUrl ||
            consultantDetails.twitterUrl ||
            consultantDetails.githubUrl ||
            consultantDetails.websiteUrl) && (
            <div className="flex flex-wrap gap-3 mt-4">
              {userDetails.linkedinUrl && (
                <a
                  href={userDetails.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Linkedin className="w-4 h-4" />
                  <span>LinkedIn</span>
                </a>
              )}
              {consultantDetails.twitterUrl && (
                <a
                  href={consultantDetails.twitterUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Twitter className="w-4 h-4" />
                  <span>Twitter</span>
                </a>
              )}
              {consultantDetails.githubUrl && (
                <a
                  href={consultantDetails.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Github className="w-4 h-4" />
                  <span>GitHub</span>
                </a>
              )}
              {consultantDetails.websiteUrl && (
                <a
                  href={consultantDetails.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Globe className="w-4 h-4" />
                  <span>Website</span>
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
