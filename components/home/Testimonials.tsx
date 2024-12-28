"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Star, User } from "lucide-react";
import type { ReviewWithProfiles } from "@/types/review";
import styles from "./Testimonials.module.css";

const ReviewCard = ({ review }: { review: ReviewWithProfiles }) => {
  const stars = Array.from({ length: 5 }, (_, position) => ({
    id: `star-${position}-${review.id}`,
    filled: position < review.rating,
  }));

  return (
    <Card className="w-[300px] flex-shrink-0 mx-3 bg-white hover:shadow-lg transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] border border-gray-100">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 border border-gray-100">
            {review.consulteeProfile?.user?.image ? (
              <AvatarImage
                src={review.consulteeProfile.user.image}
                alt={review.consulteeProfile.user.name || "Reviewer"}
              />
            ) : (
              <AvatarFallback>
                <User className="h-5 w-5" />
              </AvatarFallback>
            )}
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <h4 className="font-semibold truncate">
                  {review.consulteeProfile?.user?.name || "Anonymous"}
                </h4>
                <p className="text-sm text-gray-500 truncate">
                  Review for {review.consultantProfile?.user?.name}
                </p>
              </div>
              <div className="flex items-center flex-shrink-0">
                {stars.map((star) => (
                  <Star
                    key={star.id}
                    className={`w-3 h-3 ${
                      star.filled
                        ? "text-yellow-400 fill-yellow-400"
                        : "text-gray-300"
                    }`}
                  />
                ))}
              </div>
            </div>
            <p className="mt-3 text-gray-700 text-sm line-clamp-3">
              {review.reviewDescription || "No review description provided"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default function Testimonials() {
  const [reviews, setReviews] = useState<ReviewWithProfiles[]>([]);
  const [loading, setLoading] = useState(true);
  const [skeletonIds] = useState(() =>
    Array.from({ length: 3 }, (_, i) => `skeleton-${i}-${Math.random()}`),
  );

  useEffect(() => {
    async function fetchReviews() {
      try {
        const response = await fetch("/api/user/reviews?rating=4");
        if (!response.ok) throw new Error("Failed to fetch");

        const data = await response.json();
        if (data?.data) {
          setReviews(data.data);
        }
      } catch (error) {
        console.error("Error fetching reviews:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchReviews();
  }, []);

  if (loading) {
    return (
      <section className="py-16 bg-gray-50">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">
            What Our Users Say
          </h2>
          <div className="flex justify-center">
            <div className="animate-pulse space-y-4">
              {skeletonIds.map((id) => (
                <div
                  key={id}
                  className="w-[300px] h-[160px] bg-gray-200 rounded-lg"
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Ensure we have enough reviews for smooth scrolling
  const displayReviews =
    reviews.length >= 4 ? reviews : [...reviews, ...reviews];

  const marqueeGroups = Array.from({ length: 3 }, (_, i) => ({
    ltrId: `ltr-group-${i}-${Math.random()}`,
    rtlId: `rtl-group-${i}-${Math.random()}`,
  }));

  return (
    <section className="py-16 bg-gray-50 overflow-hidden relative">
      <div
        className="absolute inset-0 opacity-30"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgb(0 0 0 / 0.05) 1px, transparent 0)`,
          backgroundSize: "40px 40px",
        }}
      />
      <div className="container mx-auto px-4 relative">
        <h2 className="text-3xl font-bold text-center mb-16">
          What Our Users Say
        </h2>
      </div>

      <div className="space-y-12">
        {/* First Row: Left to Right */}
        <div className="relative py-4">
          <div className={styles["marquee-container"]}>
            <div className={styles["marquee-track-ltr"]}>
              {marqueeGroups.map((group) => (
                <div key={group.ltrId} className="flex">
                  {displayReviews.map((review) => (
                    <ReviewCard
                      key={`${review.id}-${group.ltrId}`}
                      review={review}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Second Row: Right to Left */}
        <div className="relative py-4">
          <div className={styles["marquee-container"]}>
            <div className={styles["marquee-track-rtl"]}>
              {marqueeGroups.map((group) => (
                <div key={group.rtlId} className="flex">
                  {displayReviews.map((review) => (
                    <ReviewCard
                      key={`${review.id}-${group.rtlId}`}
                      review={review}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
