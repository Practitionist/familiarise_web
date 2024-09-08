import { Prisma } from '@prisma/client';

export type TConsultantReview = Prisma.ConsultantReviewGetPayload<{
  select: {
    id: true,
    reviewDescription: true,
    rating: true,
    createdAt: true,
    consulteeProfileId: true
  }
}>;

export type TUserDetails = Prisma.UserGetPayload<{
  select: {
    id: true,
    name: true,
    email: true,
    emailVerified: true,
    image: true,
    phone: true,
    address: true,
    onboardingCompleted: true,
    role: true,
    consultantProfileId: true,
    consulteeProfileId: true
  }
}>;

export type TConsultantProfile = Prisma.ConsultantProfileGetPayload<{
  include: {
    slotsOfAvailabiltyWeekly: true,
    slotsOfAvailabiltyCustom: true,
    consultationPlans: true
  }
}>;

export type TSlotTiming = {
  slotId: string;
  localStartTime: string;
  localEndTime: string;
};