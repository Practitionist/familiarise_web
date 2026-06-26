import { cache } from "react";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";

/**
 * Server-side data access for the landing page.
 * Uses React cache() for per-request deduplication.
 */

export const getHomeExperts = cache(async () => {
  const consultants = await prisma.consultantProfile.findMany({
    // #781 §B — soft-deleted profiles leave public surfaces
    where: { verificationStatus: "VERIFIED", deletedAt: null },
    orderBy: { rating: "desc" },
    take: 10,
    include: {
      user: {
        select: {
          id: true,
          name: true,
          image: true,
          profileDisplayImage: true,
        },
      },
      domain: { select: { id: true, name: true } },
      subDomains: { select: { id: true, name: true } },
      tags: { select: { id: true, name: true } },
      reviews: {
        select: { rating: true },
        take: 10,
      },
      subscriptionPlans: {
        select: {
          id: true,
          title: true,
          price: true,
          priceCurrency: true,
          durationInMonths: true,
          callsPerWeek: true,
          emailSupport: true,
          totalSessions: true,
        },
        take: 5,
      },
    },
  });
  // price is already number at the JS boundary (#780 result extension);
  // toPlain strips the extension's inspect symbol so the rows can cross
  // the RSC boundary.
  return toPlain(consultants);
});

export const getHomeReviews = cache(async () => {
  const reviews = await prisma.consultantReview.findMany({
    // #781 §B — soft-deleted profiles leave public surfaces
    where: { rating: { gte: 4 }, consultantProfile: { deletedAt: null } },
    take: 20,
    include: {
      consultantProfile: {
        include: {
          user: { select: { name: true } },
        },
      },
      consulteeProfile: {
        include: {
          user: { select: { name: true, image: true } },
        },
      },
    },
    orderBy: { rating: "desc" },
  });
  return toPlain(reviews);
});

export const getHomeImages = cache(async () => {
  const images = await fetchImagesFromSupabaseStorage(
    "assets",
    "images/landing-page",
  );
  return images || [];
});
