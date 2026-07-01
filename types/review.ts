import { Prisma } from "@prisma/client";
import type { ConsultantPublicScalars } from "@/lib/data/consultant-public";

/**
 * Review with both consultant and consultee profile data.
 * Matches the include pattern in GET /api/user/reviews.
 * Used by home page testimonials and upcoming events sections.
 * The consultantProfile is projected to the public allowlist (no statutory PII). (#946)
 */
export type TConsultantReview = Prisma.ConsultantReviewGetPayload<{
  include: {
    consultantProfile: {
      select: ConsultantPublicScalars & {
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
