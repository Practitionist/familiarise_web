import { ConsultantReview } from "@prisma/client";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: ConsultantReview[];
}

export function ReviewsSection({ reviews }: ReviewsSectionProps) {
  return (
    <div>
      <h3 className="font-semibold text-lg mb-4">
        All Reviews ({reviews?.length || 0})
      </h3>
      <div className="space-y-4">
        {reviews && reviews.length > 0 ? (
          reviews.map((review) => <Review key={review.id} {...review} />)
        ) : (
          <p>No reviews available.</p>
        )}
      </div>
    </div>
  );
}
