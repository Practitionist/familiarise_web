import { Prisma } from "@prisma/client";

/**
 * Review with both consultant and consultee profile data.
 * Matches the include pattern in GET /api/user/reviews.
 * Used by home page testimonials and upcoming events sections.
 */
export type TConsultantReview = Prisma.ConsultantReviewGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: {
          select: {
            name: true;
          };
        };
      };
    };
    consulteeProfile: {
      include: {
        user: {
          select: {
            name: true;
            image: true;
          };
        };
      };
    };
  };
}>;

/** @deprecated Use TConsultantReview instead */
export type ReviewWithProfiles = TConsultantReview;
