import { ConsultantReview } from "@prisma/client";

export type ReviewWithProfiles = ConsultantReview & {
  consulteeProfile: {
    user: {
      name: string | null;
      image: string | null;
    };
  };
  consultantProfile: {
    user: {
      name: string | null;
    };
  };
};
