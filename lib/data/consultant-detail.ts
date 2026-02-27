import { cache } from "react";
import prisma from "@/lib/prisma";

/**
 * Server-side data access for the expert detail page.
 * Uses the public access pattern (verified only, public user fields).
 */

export const getConsultantDetail = cache(async (consultantId: string) => {
  const consultant = await prisma.consultantProfile.findUnique({
    where: {
      id: consultantId,
      verificationStatus: "VERIFIED",
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          image: true,
          profileDisplayImage: true,
          bio: true,
          city: true,
          country: true,
          linkedinUrl: true,
          timezone: true,
          workExperiences: {
            orderBy: [{ isCurrent: "desc" as const }, { startDate: "desc" as const }],
          },
          education: {
            orderBy: { endYear: "desc" as const },
          },
          certifications: {
            orderBy: { issueDate: "desc" as const },
          },
        },
      },
      domain: true,
      subDomains: true,
      tags: true,
      slotsOfAvailabilityWeekly: true,
      slotsOfAvailabilityCustom: true,
      consultationPlans: true,
      subscriptionPlans: {
        include: {
          subscriptionContents: {
            orderBy: { order: "asc" as const },
          },
        },
      },
      webinarPlans: true,
      classPlans: true,
    },
  });
  return consultant;
});

export const getConsultantReviews = cache(
  async (consultantProfileId: string) => {
    const reviews = await prisma.consultantReview.findMany({
      where: { consultantProfileId },
      take: 20,
      include: {
        consultantProfile: {
          include: { user: { select: { name: true } } },
        },
        consulteeProfile: {
          include: { user: { select: { name: true, image: true } } },
        },
      },
      orderBy: { rating: "desc" },
    });
    return reviews;
  },
);
