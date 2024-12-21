"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EXPERTS } from "@/constants/homePageData";
import { useEffect, useState } from "react";
import { User, Star, StarHalf } from "lucide-react";
import Link from "next/link";

interface Tag {
  id: string;
  name: string;
}

interface Expert {
  id: string;
  description: string;
  specialization: string;
  experience: string;
  rating: number;
  user: {
    name: string | null;
    image: string | null;
  };
  domain: {
    name: string;
  };
  tags: Tag[];
}

export default function FeaturedExpertsSection() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchExperts() {
      try {
        const response = await fetch("/api/user/consultants?limit=5");
        if (!response.ok) throw new Error("Failed to fetch");

        const data = await response.json();
        if (data?.data && data.data.length > 0) {
          setExperts(data.data);
        } else {
          // Fallback to constants if no data
          setExperts(
            EXPERTS.map((expert) => ({
              id: String(Math.random()),
              description: "",
              specialization: "",
              experience: "1-3 years",
              rating: 5,
              user: {
                name: expert.name,
                image: null,
              },
              domain: {
                name: expert.expertise,
              },
              tags: [],
            })),
          );
        }
      } catch (error) {
        console.error("Error fetching experts:", error);
        // Fallback to constants on error
        setExperts(
          EXPERTS.map((expert) => ({
            id: String(Math.random()),
            description: "",
            specialization: "",
            experience: "1-3 years",
            rating: 5,
            user: {
              name: expert.name,
              image: null,
            },
            domain: {
              name: expert.expertise,
            },
            tags: [],
          })),
        );
      } finally {
        setLoading(false);
      }
    }

    fetchExperts();
  }, []);

  const renderRating = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;

    return (
      <div className="flex items-center gap-1 justify-center">
        {[...Array(fullStars)].map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
        ))}
        {hasHalfStar && (
          <StarHalf className="w-4 h-4 fill-yellow-400 text-yellow-400" />
        )}
        <span className="text-sm text-gray-600 ml-1">{rating.toFixed(1)}</span>
      </div>
    );
  };

  return (
    <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8">
          {loading
            ? // Show loading skeletons
              Array(5)
                .fill(0)
                .map((_, index) => (
                  <Card
                    key={index}
                    className="hover:shadow-xl transition-shadow duration-300 hover:-translate-y-1"
                  >
                    <CardHeader>
                      <div className="w-16 h-16 rounded-full bg-gray-200 animate-pulse mx-auto mb-4" />
                      <div className="h-6 bg-gray-200 rounded animate-pulse" />
                    </CardHeader>
                    <CardContent>
                      <div className="h-4 bg-gray-200 rounded animate-pulse mb-2" />
                      <div className="h-4 bg-gray-200 rounded animate-pulse" />
                    </CardContent>
                  </Card>
                ))
            : experts.map((expert) => (
                <Link
                  key={expert.id}
                  href={`/explore/experts/${expert.id}`}
                  className="block hover:no-underline"
                >
                  <Card className="hover:shadow-xl transition-shadow duration-300 hover:-translate-y-1 h-full">
                    <CardHeader>
                      <Avatar className="mx-auto mb-4 h-16 w-16">
                        <AvatarImage
                          src={expert.user.image || "/placeholder-user.jpg"}
                          alt={expert.user.name || "Expert"}
                        />
                        <AvatarFallback>
                          <User className="h-8 w-8" />
                        </AvatarFallback>
                      </Avatar>
                      <h3 className="text-lg font-bold text-center">
                        {expert.user.name}
                      </h3>
                      {renderRating(expert.rating)}
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <p className="text-sm text-gray-500 text-center">
                          {expert.specialization || expert.domain.name}
                        </p>
                        <p className="text-xs text-gray-400 text-center">
                          {expert.experience} experience
                        </p>
                      </div>
                      {expert.tags && expert.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 justify-center">
                          {expert.tags.slice(0, 3).map((tag) => (
                            <Badge
                              key={tag.id}
                              variant="secondary"
                              className="text-xs"
                            >
                              {tag.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
        </div>
      </div>
    </section>
  );
}
