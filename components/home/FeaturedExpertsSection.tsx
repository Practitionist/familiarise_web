"use client";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { useEffect, useState } from "react";
import { User, Star, StarHalf } from "lucide-react";
import { TConsultantProfile } from "@/types/consultant";
import styles from "./FeaturedExpertsSection.module.css";

function RatingStars({ rating }: { rating: number }) {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 >= 0.5;

  return (
    <div className="flex items-center gap-0.5 justify-center">
      {Array.from({ length: fullStars }, (_, i) => (
        <Star
          key={`star-${i}`}
          className="w-4 h-4 fill-yellow-400 text-yellow-400"
        />
      ))}
      {hasHalfStar && (
        <StarHalf className="w-4 h-4 fill-yellow-400 text-yellow-400" />
      )}
      <span className="text-sm text-gray-600 ml-1">{rating.toFixed(1)}</span>
    </div>
  );
}

function ExpertCard({
  expert,
  className = "",
}: {
  expert: TConsultantProfile;
  className?: string;
}) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className={`block hover:no-underline flex-shrink-0 w-[280px] ${className}`}
    >
      <Card className="hover:shadow-lg transition-shadow duration-300 hover:-translate-y-0.5 h-full mx-3">
        <CardHeader className="space-y-3">
          <Avatar className="mx-auto h-16 w-16">
            <AvatarImage
              src={expert.user.image || "/placeholder-user.jpg"}
              alt={expert.user.name || "Expert"}
            />
            <AvatarFallback>
              <User className="h-8 w-8" />
            </AvatarFallback>
          </Avatar>
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
}

function LoadingSkeleton() {
  return (
    <div className="flex-shrink-0 w-[280px]">
      <Card className="mx-3">
        <CardHeader>
          <div className="w-16 h-16 rounded-full bg-gray-200 animate-pulse mx-auto mb-3" />
          <div className="h-5 bg-gray-200 rounded animate-pulse w-3/4 mx-auto" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2 mx-auto" />
            <div className="h-3 bg-gray-200 rounded animate-pulse w-1/3 mx-auto" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function FeaturedExpertsSection() {
  const [experts, setExperts] = useState<TConsultantProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchExperts() {
      try {
        const response = await fetch("/api/user/consultants?limit=10");
        if (!response.ok) throw new Error("Failed to fetch");

        const data = await response.json();
        if (data?.data && data.data.length > 0) {
          setExperts(data.data);
        }
      } catch (error) {
        console.error("Error fetching experts:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchExperts();
  }, []);

  return (
    <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
      {/* Header content in container */}
      <div className="container mx-auto px-4 md:px-6 mb-12">
        <div className="text-center">
          <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter">
            Meet our Featured Experts
          </h2>
          <p className="mt-4 mx-auto max-w-[700px] text-gray-500 md:text-xl">
            We have a diverse team of experts ready to share their knowledge and
            expertise with you.
          </p>
          <Link href="/explore/experts">
            <Button className="mt-8 dark:bg-gray-800 text-white hover:bg-gray-700 transition-colors duration-300">
              View All Experts
            </Button>
          </Link>
        </div>
      </div>

      {/* Full-width marquee */}
      <div className="w-full overflow-hidden">
        <div className={styles["marquee-container"]}>
          <div className={styles["marquee-track"]}>
            {loading ? (
              // Show loading skeletons
              Array.from({ length: 10 }, (_, index) => (
                <LoadingSkeleton key={`skeleton-${index}`} />
              ))
            ) : (
              <>
                {/* First set */}
                {experts.map((expert) => (
                  <ExpertCard key={expert.id} expert={expert} />
                ))}
                {/* Second set */}
                {experts.map((expert) => (
                  <ExpertCard key={`${expert.id}-2`} expert={expert} />
                ))}
                {/* Third set */}
                {experts.map((expert) => (
                  <ExpertCard key={`${expert.id}-3`} expert={expert} />
                ))}
                {/* Fourth set */}
                {experts.map((expert) => (
                  <ExpertCard key={`${expert.id}-4`} expert={expert} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
