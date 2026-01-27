"use client";

import Image from "next/image";
import { Star, MapPin, Briefcase, Clock, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { User } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";

interface ProfileHeaderProps {
  userDetails: User;
  consultantDetails: TConsultantProfile;
}

export function ProfileHeader({
  userDetails,
  consultantDetails,
}: ProfileHeaderProps) {
  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 md:p-8">
      <div className="flex flex-col sm:flex-row gap-6">
        {/* Profile Display Image - Square format */}
        <div className="relative flex-shrink-0">
          {userDetails.profileDisplayImage ? (
            <div className="w-32 h-32 md:w-48 md:h-48 rounded-xl overflow-hidden ring-4 ring-zinc-100 relative">
              <Image
                src={userDetails.profileDisplayImage}
                alt={userDetails.name || "Expert"}
                fill
                className="object-cover"
              />
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute bottom-2 right-2 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-white">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </div>
          ) : (
            <>
              <Avatar className="w-24 h-24 md:w-32 md:h-32 ring-4 ring-zinc-100">
                <AvatarImage
                  src={userDetails.image || "/placeholder-user.jpg"}
                  alt={userDetails.name || "Expert"}
                  className="object-cover"
                />
                <AvatarFallback className="text-2xl bg-zinc-900 text-white">
                  {userDetails.name?.charAt(0) || "E"}
                </AvatarFallback>
              </Avatar>
              {/* Verified Badge */}
              {consultantDetails.isVerified && (
                <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full flex items-center justify-center border-4 border-white">
                  <CheckCircle2 className="w-4 h-4 text-white" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-start gap-3 mb-2">
            <h1 className="text-2xl md:text-3xl font-bold text-zinc-900">
              {userDetails.name}
            </h1>
            {consultantDetails.headline && (
              <Badge className="bg-zinc-900 text-white hover:bg-zinc-800">
                {consultantDetails.headline}
              </Badge>
            )}
          </div>

          {/* Rating */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-5 h-5 ${
                    i < Math.floor(consultantDetails.rating)
                      ? "fill-amber-400 text-amber-400"
                      : "fill-zinc-200 text-zinc-200"
                  }`}
                />
              ))}
            </div>
            <span className="font-semibold text-zinc-900">
              {consultantDetails.rating.toFixed(1)}
            </span>
            <span className="text-zinc-400">•</span>
            <span className="text-zinc-500">
              {consultantDetails.reviews?.length || 0} reviews
            </span>
          </div>

          {/* Meta */}
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2 text-zinc-600">
              <Briefcase className="w-4 h-4 text-zinc-400" />
              <span>{consultantDetails.domain.name}</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-600">
              <Clock className="w-4 h-4 text-zinc-400" />
              <span>{consultantDetails.experience} experience</span>
            </div>
            {userDetails.timezone && (
              <div className="flex items-center gap-2 text-zinc-600">
                <MapPin className="w-4 h-4 text-zinc-400" />
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
                className="border-zinc-300 text-zinc-600"
              >
                {subdomain.name}
              </Badge>
            ))}
            {consultantDetails.tags?.slice(0, 4).map((tag) => (
              <Badge
                key={tag.id}
                className="bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
