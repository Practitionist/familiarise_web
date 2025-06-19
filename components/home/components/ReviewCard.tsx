import React from "react";
import { Star, User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import type { ReviewWithProfiles } from "@/types/review";

interface ReviewCardProps {
  review: ReviewWithProfiles;
}

const ReviewCard = React.memo(({ review }: ReviewCardProps) => {
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
                    className={`w-3 h-3 ${star.filled ? "text-yellow-400 fill-yellow-400" : "text-gray-300"}`}
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
});

ReviewCard.displayName = "ReviewCard";

export default ReviewCard;