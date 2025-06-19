import React from "react";
import { Star, StarHalf } from "lucide-react";

interface RatingStarsProps {
  rating: number;
}

const RatingStars = React.memo(({ rating }: RatingStarsProps) => {
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
});

RatingStars.displayName = "RatingStars";

export default RatingStars;
