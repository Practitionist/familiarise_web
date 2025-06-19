import React, { useState } from "react";
import Link from "next/link";
import { User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import RatingStars from "./RatingStars";
import type { TConsultantProfile } from "@/types/consultant";

interface ExpertCardProps {
  expert: TConsultantProfile;
  className?: string;
}

const ExpertCard = React.memo(({ expert, className = "" }: ExpertCardProps) => {
  const [isAvatarLoaded, setIsAvatarLoaded] = useState(false);

  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className={`block hover:no-underline flex-shrink-0 w-[280px] ${className}`}
      prefetch={false}
    >
      <Card className="hover:shadow-lg transition-shadow duration-300 hover:-translate-y-0.5 h-full mx-3">
        <CardHeader className="space-y-3">
          <div className="relative mx-auto h-16 w-16">
            {!isAvatarLoaded && (
              <div className="absolute inset-0 h-16 w-16 rounded-full bg-gray-300 animate-pulse" />
            )}
            <Avatar
              className={`mx-auto h-16 w-16 ${isAvatarLoaded ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
            >
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
                onLoad={() => setIsAvatarLoaded(true)}
                onError={() => setIsAvatarLoaded(true)}
              />
              <AvatarFallback>
                <User className="h-8 w-8" />
              </AvatarFallback>
            </Avatar>
          </div>
          <h3 className="text-lg font-semibold text-center line-clamp-1">
            {expert.user.name}
          </h3>
          <RatingStars rating={expert.rating} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center">
            <p className="text-sm text-gray-600 font-medium line-clamp-1">
              {expert.specialization || expert.domain.name}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {expert.experience} experience
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {expert.tags?.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="text-xs px-2 py-0.5"
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

ExpertCard.displayName = "ExpertCard";

export default ExpertCard;
