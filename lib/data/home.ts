import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { stripAnonymousReviewers } from "@/lib/data/review-privacy";
import { toPlain } from "@/lib/data/serialize";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";

/**
 * Server-side data access for the landing page.
 *
 * Wrapped in unstable_cache so the curated landing-page reads are served from the
 * Next data cache (cross-request, cross-instance on Netlify — the adapter backs the
 * handler with a regional blob store) instead of opening a cross-region pooled
 * connection on every request. Bounded staleness is fine for a marketing surface; the
 * consumers don't read the rows' Date fields, so cache serialization is safe (#932).
 *
 * These windows are deliberately the SAME as `/`'s route-level revalidate. Next
 * resolves a route's revalidate to the minimum of its segment value and every data
 * cache entry read while rendering it, so a shorter window here would silently cap
 * the page's ISR interval — which is exactly why the landing page was regenerating
 * every 2 minutes while its own config asked for longer. Freshness comes from the
 * on-demand purges at the write sites, not from a short interval.
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
            sessionsPerWeek: true,
            emailSupport: true,
            totalSessions: true,
            // Same shape as lib/data/explore-experts.ts — both feed
            // IConsultantCardData, so both must carry the trial fields.
            trialEnabled: true,
            trialPriceInPaise: true,
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
  { revalidate: 3600, tags: ["experts", "home"] },
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
    return toPlain(stripAnonymousReviewers(reviews));
  },
  ["home-reviews"],
  { revalidate: 3600, tags: ["reviews", "home"] },
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
  { revalidate: 3600, tags: ["home-images"] },
);
