import { cache } from "react";
import prisma from "@/lib/prisma";

/**
 * Server-side data access for the explore experts page.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchExpertsMetadata) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getExpertsMetadata)  — React.cache() wrapper. Used by Server Components.
 */

/** Shared include shape for consultant list queries. */
export const consultantListInclude = {
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      profileDisplayImage: true,
      workExperiences: {
        select: { company: true, companyDomain: true, isCurrent: true },
        take: 3,
      },
    },
  },
  domain: { select: { id: true, name: true } },
  subDomains: { select: { id: true, name: true } },
  tags: { select: { id: true, name: true } },
  reviews: { select: { rating: true }, take: 10 },
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
} as const;

// ---------------------------------------------------------------------------
// Experts metadata (filters, domain grid, language list)
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchExpertsMetadata() {
  const [
    domainsWithSubs,
    tags,
    consultantMetadata,
    availableLanguages,
    availableCompanies,
  ] = await Promise.all([
    // Domains + subdomains
    prisma.domain.findMany({
      include: {
        subDomains: {
          select: { id: true, name: true, domainId: true },
        },
      },
    }),
    // Tags
    prisma.tag.findMany({
      select: { id: true, name: true, domainId: true },
    }),
    // Consultant metadata (counts, domain breakdown, avg rating)
    (async () => {
      const [totalConsultants, consultantsByDomain, averageRating] =
        await Promise.all([
          prisma.consultantProfile.count({
            where: { verificationStatus: "VERIFIED" },
          }),
          prisma.domain.findMany({
            select: {
              id: true,
              name: true,
              _count: {
                select: {
                  consultantProfiles: {
                    where: { verificationStatus: "VERIFIED" },
                  },
                },
              },
            },
          }),
          prisma.consultantProfile.aggregate({
            where: { verificationStatus: "VERIFIED" },
            _avg: { rating: true },
          }),
        ]);

      return {
        totalConsultants,
        consultantsByDomain: consultantsByDomain.map((d) => ({
          id: d.id,
          name: d.name,
          consultantCount: d._count.consultantProfiles,
        })),
        averageRating: averageRating._avg.rating || 0,
      };
    })(),
    // Available languages via raw SQL
    prisma.$queryRaw<{ lang: string }[]>`
        SELECT DISTINCT unnest(languages) as lang
        FROM "ConsultantProfile"
        WHERE "verificationStatus" = 'VERIFIED'
        ORDER BY lang
      `.then((result) => result.map((r) => r.lang)),
    // Available companies (from verified consultants' work experiences)
    prisma.workExperience.findMany({
      where: {
        company: { not: "" },
        user: {
          consultantProfile: { verificationStatus: "VERIFIED" },
        },
      },
      select: { company: true },
      distinct: ["company"],
      orderBy: { company: "asc" },
    }).then((result) => result.map((r) => r.company)),
  ]);

  return {
    domains: domainsWithSubs.map((d) => ({ id: d.id, name: d.name })),
    subdomains: domainsWithSubs.flatMap((d) =>
      d.subDomains.map((sd) => ({
        id: sd.id,
        name: sd.name,
        domainId: sd.domainId,
      })),
    ),
    tags,
    consultantMetadata,
    availableLanguages,
    availableCompanies,
  };
}

/** Cached wrapper for Server Components. */
export const getExpertsMetadata = cache(fetchExpertsMetadata);

// ---------------------------------------------------------------------------
// Curated experts (Featured / Trending / Newest rows)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recent reviews (for testimonial sections)
// ---------------------------------------------------------------------------

/** Fetch recent high-quality reviews for social proof sections. */
export const getRecentReviews = cache(async (limit: number = 6) => {
  return prisma.consultantReview.findMany({
    where: { rating: { gte: 4 } },
    orderBy: { createdAt: "desc" },
    take: limit,
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
  });
});

// ---------------------------------------------------------------------------
// Curated experts (Featured / Trending / Newest rows)
// ---------------------------------------------------------------------------

/** Cached wrapper for Server Components. */
export const getCuratedExperts = cache(
  async (sort: "rating" | "trending" | "newest", limit: number = 8) => {
    let orderBy: Record<string, unknown>;
    switch (sort) {
      case "rating":
        orderBy = { rating: "desc" };
        break;
      case "trending":
        orderBy = { reviews: { _count: "desc" } };
        break;
      case "newest":
        orderBy = { createdAt: "desc" };
        break;
    }

    return prisma.consultantProfile.findMany({
      where: { verificationStatus: "VERIFIED" },
      orderBy,
      take: limit,
      include: consultantListInclude,
    });
  },
);
