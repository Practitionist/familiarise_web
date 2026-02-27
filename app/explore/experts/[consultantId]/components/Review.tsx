import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TConsultantReview } from "@/types/review";

import { StarIcon } from "lucide-react";
import React from "react";

const Review: React.FC<Readonly<TConsultantReview>> = ({
  consulteeProfile,
  createdAt,
  rating,
  reviewDescription,
}) => {
  const reviewerName = consulteeProfile?.user?.name || "Anonymous";
  const reviewerImage = consulteeProfile?.user?.image || null;

  return (
    <div className="flex items-start space-x-4 p-4 bg-white rounded-lg shadow-sm">
      <Avatar className="w-10 h-10">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback>{reviewerName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-md font-semibold text-gray-800">
              {reviewerName}
            </h4>
            <p className="text-xs text-gray-500">
              {new Date(createdAt).toLocaleDateString("en-IN")}
            </p>
          </div>
          <div className="flex items-center">
            {[...Array(5)].map((_, i) => (
              <StarIcon
                key={`star-${rating}-${i}`}
                className={`w-4 h-4 ${i < rating ? "text-yellow-400" : "text-gray-200"}`}
              />
            ))}
          </div>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          {reviewDescription}
        </p>
      </div>
    </div>
  );
};

export default Review;
