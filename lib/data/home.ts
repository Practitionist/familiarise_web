import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";

/**
 * Server-side data access for the landing page.
 *
 * Wrapped in unstable_cache so the curated landing-page reads are served from the
 * Next data cache (cross-request, cross-instance on Netlify) instead of opening a
 * cross-region pooled connection on every request — the root layout's session read
 * forces these pages dynamic, so page-level ISR can't apply and the cache has to
 * live at the data layer. Bounded staleness is fine for a marketing surface; the
 * consumers don't read the rows' Date fields, so cache serialization is safe (#932).
 */

export const getHomeExperts = unstable_cache(
  async () => {
    const consultants = await prisma.consultantProfile.findMany({
      // #781 §B — soft-deleted profiles leave public surfaces
      where: { verificationStatus: "VERIFIED", deletedAt: null },
      orderBy: { rating: "desc" },
      take: 10,
      select: {
        ...consultantPublicScalars,
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
          where: { deletedAt: null },
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
  },
  ["home-experts"],
  { revalidate: 120, tags: ["experts", "home"] },
);

export const getHomeReviews = unstable_cache(
  async () => {
    const reviews = await prisma.consultantReview.findMany({
      // #781 §B — soft-deleted profiles leave public surfaces
      // #693 — moderation-removed reviews leave public surfaces too
      where: {
        rating: { gte: 4 },
        deletedAt: null,
        consultantProfile: { deletedAt: null },
      },
      take: 20,
      include: {
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
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
  },
  ["home-reviews"],
  { revalidate: 120, tags: ["reviews", "home"] },
);

export const getHomeImages = unstable_cache(
  async () => {
    const images = await fetchImagesFromSupabaseStorage(
      "assets",
      "images/landing-page",
    );
    return images || [];
  },
  ["home-images"],
  { revalidate: 600, tags: ["home-images"] },
);
