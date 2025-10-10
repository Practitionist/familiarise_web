"use client";

import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { User, Star, StarHalf } from "lucide-react";
import { TConsultantProfile } from "@/types/consultant";

// Fetcher function for the experts API
const fetchFeaturedExperts = async (): Promise<TConsultantProfile[]> => {
  const response = await fetch("/api/user/consultants?limit=5");
  if (!response.ok) throw new Error("Failed to fetch experts");
  const data = await response.json();
  return data?.data || [];
};

export function FeaturedExperts() {
  const { data: experts = [], isLoading } = useQuery({
    queryKey: ["featured-experts"],
    queryFn: fetchFeaturedExperts,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  const renderRating = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;

    return (
      <div className="flex items-center gap-0.5 justify-center">
        {[...Array(fullStars)].map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
        ))}
        {hasHalfStar && (
          <StarHalf className="w-4 h-4 fill-yellow-400 text-yellow-400" />
        )}
        <span className="text-sm text-gray-400 ml-1">{rating.toFixed(1)}</span>
      </div>
    );
  };

  return (
    <section className="w-full py-32 bg-gradient-to-b from-black via-gray-950/50 to-black">
      <div className="space-y-8 px-4 md:px-6">
        <div className="flex flex-col items-center justify-center space-y-4 text-center">
          <div className="space-y-2">
            <div className="inline-block rounded-lg bg-gray-800 border border-gray-700 px-3 py-1 text-sm text-gray-100">
              Featured Experts
            </div>
            <h2 className="text-3xl font-bold tracking-tighter sm:text-5xl bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">
              Top Consultants
            </h2>
            <p className="max-w-[900px] text-gray-400 md:text-lg/relaxed lg:text-base/relaxed xl:text-lg/relaxed">
              Discover the best of the best. Our top consultants are ready to
              help you with your business needs.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6 max-w-7xl mx-auto">
          {isLoading
            ? // Show loading skeletons
              Array(5)
                .fill(0)
                .map((_, index) => (
                  <Card
                    key={index}
                    className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border-gray-800/50 backdrop-blur-sm"
                  >
                    <CardHeader>
                      <div className="w-16 h-16 rounded-full bg-gray-800/80 animate-pulse mx-auto mb-3" />
                      <div className="h-5 bg-gray-800/80 rounded animate-pulse w-3/4 mx-auto" />
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <div className="h-4 bg-gray-800/80 rounded animate-pulse w-1/2 mx-auto" />
                        <div className="h-3 bg-gray-800/80 rounded animate-pulse w-1/3 mx-auto" />
                      </div>
                    </CardContent>
                  </Card>
                ))
            : experts.map((expert) => (
                <Link
                  key={expert.id}
                  href={`/explore/experts/${expert.id}`}
                  className="block hover:no-underline"
                >
                  <Card className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border-gray-800/50 rounded-3xl backdrop-blur-sm hover:border-gray-600/50 hover:shadow-2xl transition-all duration-500 hover:-translate-y-1 h-full flex flex-col">
                    <CardHeader className="space-y-3 flex-shrink-0">
                      <Avatar className="mx-auto h-16 w-16 border-2 border-gray-700/50">
                        <AvatarImage
                          src={expert.user.image || "/placeholder-user.jpg"}
                          alt={expert.user.name || "Expert"}
                        />
                        <AvatarFallback className="bg-gray-800 border border-gray-700">
                          <User className="h-8 w-8 text-gray-400" />
                        </AvatarFallback>
                      </Avatar>
                      <h3 className="text-lg font-semibold text-center line-clamp-1 text-gray-100">
                        {expert.user.name}
                      </h3>
                      {renderRating(expert.rating)}
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="text-center">
                        <p className="text-sm text-gray-300 font-medium line-clamp-1">
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
                            className="text-xs px-2 py-0.5 bg-gray-800/50 text-gray-400 border border-gray-700/50"
                          >
                            {tag.name}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
        </div>
      </div>
    </section>
  );
}
