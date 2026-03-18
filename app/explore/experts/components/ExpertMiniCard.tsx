"use client";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { User, Star, ArrowRight, Flame, Clock, BadgeCheck } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import type { IConsultantCardData } from "@/types/consultant";

interface ExpertMiniCardProps {
  expert: IConsultantCardData;
  badge?: "trending" | "new";
}

export default function ExpertMiniCard({ expert, badge }: ExpertMiniCardProps) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="group flex-shrink-0 w-[260px] block"
    >
      <div className="bg-white rounded-2xl p-5 border border-zinc-200 hover:border-zinc-300 hover:shadow-lg transition-all duration-300 h-full flex flex-col">
        {/* Badge */}
        {badge && (
          <div className="mb-3">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                badge === "trending"
                  ? "bg-orange-100 text-orange-700"
                  : "bg-emerald-100 text-emerald-700"
              }`}
            >
              {badge === "trending" ? (
                <Flame className="w-3 h-3" />
              ) : (
                <Clock className="w-3 h-3" />
              )}
              {badge === "trending" ? "Trending" : "New"}
            </span>
          </div>
        )}

        {/* Avatar + Name */}
        <div className="flex items-center gap-3 mb-3">
          <Avatar className="h-12 w-12 ring-2 ring-zinc-100 group-hover:ring-zinc-200 transition-all">
            <AvatarImage
              src={expert.user.image || "/placeholder-user.jpg"}
              alt={expert.user.name || "Expert"}
              className="object-cover"
            />
            <AvatarFallback className="bg-zinc-900 text-white">
              <User className="h-6 w-6" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-semibold text-zinc-900 line-clamp-1 group-hover:text-zinc-700 transition-colors">
                {expert.user.name}
              </h3>
              {expert.isVerified && (
                <span title="Verified by Familiarise">
                  <BadgeCheck className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
              <span className="text-xs font-medium text-zinc-600">
                {expert.rating.toFixed(1)}
              </span>
            </div>
          </div>
        </div>

        {/* Company Logos */}
        {expert.user.workExperiences &&
          expert.user.workExperiences.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2">
              {expert.user.workExperiences.slice(0, 2).map((exp, i) => (
                <CompanyLogo
                  key={`${expert.id}-company-${i}`}
                  companyName={exp.company}
                  companyDomain={exp.companyDomain ?? undefined}
                  size={24}
                  className="border-zinc-200"
                />
              ))}
            </div>
          )}

        {/* Domain badge */}
        <Badge className="text-[10px] px-2 py-0.5 bg-zinc-100 text-zinc-600 hover:bg-zinc-100 border-0 w-fit mb-2">
          {expert.domain?.name || "General"}
        </Badge>

        {/* Tags */}
        <div className="flex flex-wrap gap-1 mb-3 flex-1">
          {expert.tags?.slice(0, 2).map((tag) => (
            <span
              key={tag.id}
              className="text-[10px] px-2 py-0.5 bg-zinc-50 text-zinc-500 rounded-full"
            >
              {tag.name}
            </span>
          ))}
        </div>

        {/* View Profile */}
        <div className="flex items-center gap-1 text-xs font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
          <span>View Profile</span>
          <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
        </div>
      </div>
    </Link>
  );
}
