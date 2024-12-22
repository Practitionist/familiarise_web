"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Star, User } from "lucide-react";
import type { ReviewWithProfiles } from "@/types/review";

const ReviewCard = ({ review }: { review: ReviewWithProfiles }) => (
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
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-3 h-3 ${
                    i < review.rating
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

export default function Testimonials() {
  const [reviews, setReviews] = useState<ReviewWithProfiles[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchReviews() {
      try {
        const response = await fetch("/api/user/reviews");
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
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
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
          <div className="marquee-container">
            <div className="marquee-track-ltr">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex">
                  {displayReviews.map((review) => (
                    <ReviewCard key={`${review.id}-${i}`} review={review} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Second Row: Right to Left */}
        <div className="relative py-4">
          <div className="marquee-container">
            <div className="marquee-track-rtl">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex">
                  {displayReviews.map((review) => (
                    <ReviewCard
                      key={`${review.id}-reverse-${i}`}
                      review={review}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        .marquee-container {
          width: 100%;
          overflow: hidden;
          position: relative;
          mask-image: linear-gradient(
            to right,
            transparent,
            black 10%,
            black 90%,
            transparent
          );
          -webkit-mask-image: linear-gradient(
            to right,
            transparent,
            black 10%,
            black 90%,
            transparent
          );
        }
        .marquee-track-ltr,
        .marquee-track-rtl {
          display: flex;
          width: fit-content;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          will-change: transform;
          transition: transform 0.5s ease;
        }
        .marquee-track-ltr {
          animation-name: marquee-ltr;
          animation-duration: 180s;
          transform: translateX(calc(-100% / 3));
        }
        .marquee-track-rtl {
          animation-name: marquee-rtl;
          animation-duration: 180s;
          transform: translateX(calc(-100% / 3));
        }
        @keyframes marquee-ltr {
          0% {
            transform: translateX(calc(-100% / 3));
          }
          100% {
            transform: translateX(calc(-200% / 3));
          }
        }
        @keyframes marquee-rtl {
          0% {
            transform: translateX(calc(-100% / 3));
          }
          100% {
            transform: translateX(0);
          }
        }
        .marquee-track-ltr:hover,
        .marquee-track-rtl:hover {
          animation-play-state: paused;
        }
      `}</style>
    </section>
  );
}
