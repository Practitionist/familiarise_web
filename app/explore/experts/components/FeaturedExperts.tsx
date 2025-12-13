"use client";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { User, Star, StarHalf, ArrowRight, Award } from "lucide-react";
import { TConsultantProfile } from "@/types/consultant";

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
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  const renderRating = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;

    return (
      <div className="flex items-center gap-1">
        {[...Array(fullStars)].map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
        ))}
        {hasHalfStar && (
          <StarHalf className="w-4 h-4 fill-amber-400 text-amber-400" />
        )}
        <span className="text-sm font-medium text-zinc-700 ml-1">{rating.toFixed(1)}</span>
      </div>
    );
  };

  return (
    <section className="py-20 bg-gradient-to-b from-zinc-100 to-white relative overflow-hidden">
      {/* Background Pattern */}
      <div className="absolute inset-0 dot-pattern opacity-30" />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
        {/* Section Header */}
        <motion.div 
          className="text-center mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 rounded-full mb-6">
            <Award className="w-4 h-4 text-white" />
            <span className="text-sm font-medium text-white">Featured Experts</span>
          </div>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-zinc-900 mb-4">
            Top <span className="silver-text">Consultants</span>
          </h2>
          <p className="text-lg text-zinc-600 max-w-2xl mx-auto">
            Discover the best of the best. Our top consultants are ready to 
            help you achieve your goals.
          </p>
        </motion.div>

        {/* Experts Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {isLoading
            ? Array(5).fill(0).map((_, index) => (
                <div
                  key={index}
                  className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 animate-pulse"
                >
                  <div className="w-20 h-20 rounded-full bg-zinc-200 mx-auto mb-4" />
                  <div className="h-5 bg-zinc-200 rounded w-3/4 mx-auto mb-3" />
                  <div className="h-4 bg-zinc-200 rounded w-1/2 mx-auto mb-4" />
                  <div className="flex gap-2 justify-center">
                    <div className="h-6 bg-zinc-200 rounded-full w-16" />
                    <div className="h-6 bg-zinc-200 rounded-full w-16" />
                  </div>
                </div>
              ))
            : experts.map((expert, index) => (
                <motion.div
                  key={expert.id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: index * 0.1 }}
                >
                  <Link
                    href={`/explore/experts/${expert.id}`}
                    className="group block"
                  >
                    <div className="bg-white rounded-2xl p-6 shadow-sm border border-zinc-200 hover:border-zinc-300 hover:shadow-lg transition-all duration-300 h-full flex flex-col">
                      {/* Avatar */}
                      <div className="relative mb-4">
                        <Avatar className="mx-auto h-20 w-20 ring-4 ring-zinc-100 group-hover:ring-zinc-200 transition-all">
                          <AvatarImage
                            src={expert.user.image || "/placeholder-user.jpg"}
                            alt={expert.user.name || "Expert"}
                            className="object-cover"
                          />
                          <AvatarFallback className="bg-zinc-900 text-white">
                            <User className="h-10 w-10" />
                          </AvatarFallback>
                        </Avatar>
                        {/* Top Expert Badge */}
                        {index === 0 && (
                          <div className="absolute -top-2 -right-2 w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center shadow-lg">
                            <Award className="w-4 h-4 text-white" />
                          </div>
                        )}
                      </div>

                      {/* Name */}
                      <h3 className="text-lg font-semibold text-zinc-900 text-center mb-2 line-clamp-1 group-hover:text-zinc-700 transition-colors">
                        {expert.user.name}
                      </h3>

                      {/* Rating */}
                      <div className="flex justify-center mb-3">
                        {renderRating(expert.rating)}
                      </div>

                      {/* Specialization */}
                      <div className="text-center flex-1">
                        <p className="text-sm text-zinc-600 font-medium line-clamp-1 mb-1">
                          {expert.specialization || expert.domain.name}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {expert.experience} experience
                        </p>
                      </div>

                      {/* Tags */}
                      <div className="flex flex-wrap gap-1.5 justify-center mt-4">
                        {expert.tags?.slice(0, 2).map((tag) => (
                          <Badge
                            key={tag.id}
                            className="text-xs px-2 py-0.5 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 border-0"
                          >
                            {tag.name}
                          </Badge>
                        ))}
                      </div>

                      {/* View Profile */}
                      <div className="mt-4 flex items-center justify-center gap-1 text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
                        <span>View Profile</span>
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </div>
                    </div>
                  </Link>
                </motion.div>
              ))}
        </div>
      </div>
    </section>
  );
}
