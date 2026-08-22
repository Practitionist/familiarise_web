"use client";

import { Star, MessageSquare } from "lucide-react";
import { TConsultantReview } from "@/types/review";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: TConsultantReview[];
}

export function ReviewsSection({ reviews }: ReviewsSectionProps) {
  const averageRating =
    reviews.length > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : 0;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-card md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Reviews ({reviews?.length || 0})
            </h3>
            {reviews.length > 0 && (
              <div className="flex items-center gap-1 mt-0.5">
                <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                <span className="text-sm font-medium text-muted-foreground">
                  {averageRating.toFixed(1)} average rating
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {reviews && reviews.length > 0 ? (
          reviews.map((review) => <Review key={review.id} {...review} />)
        ) : (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-muted-foreground/70" />
            </div>
            <p className="text-muted-foreground">No reviews yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Be the first to leave a review!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
