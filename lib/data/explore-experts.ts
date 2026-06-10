import { cache } from "react";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Server-side data access for the explore experts page.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchExpertsMetadata) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getExpertsMetadata)  — React.cache() wrapper. Used by Server Components.
 */

/**
 * Shared include shape for consultant list queries.
 *
 * Typed via `satisfies Prisma.ConsultantProfileInclude` so Prisma's
 * generated types validate the shape at compile time — the returned
 * rows are then automatically narrow-typed with all the nested relations
 * (user, domain, subDomains, tags, reviews, subscriptionPlans) without
 * requiring `as const` or runtime narrowing at the caller.
 */
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
} satisfies Prisma.ConsultantProfileInclude;

// Separate include for org membership.
//
// Arch 4-Modified shape: a consultant belongs to an org via `Membership`
// (relation name "ConsultantMembership"). "Consultant" in the org context
// is `MemberRole.EXPERT`, and a hosting org is `Organization.canHost=true`.
//
// Typed via `satisfies` so Prisma's generated include types validate the
// filter at compile time (no `as const` string-literal narrowing needed).
export const orgMembershipInclude = {
  memberships: {
    where: {
      role: "EXPERT",
      status: "ACTIVE",
      organization: {
        canHost: true,
        status: "ACTIVE",
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      organization: {
        select: {
          name: true,
          slug: true,
          brandingProfile: { select: { logo: true } },
        },
      },
    },
    take: 1,
  },
} satisfies Prisma.ConsultantProfileInclude;

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
    // #781 §B — soft-deleted profiles leave public surfaces
    (async () => {
      const [totalConsultants, consultantsByDomain, averageRating] =
        await Promise.all([
          prisma.consultantProfile.count({
            where: { verificationStatus: "VERIFIED", deletedAt: null },
          }),
          prisma.domain.findMany({
            select: {
              id: true,
              name: true,
              _count: {
                select: {
                  consultantProfiles: {
                    where: { verificationStatus: "VERIFIED", deletedAt: null },
                  },
                },
              },
            },
          }),
          prisma.consultantProfile.aggregate({
            where: { verificationStatus: "VERIFIED", deletedAt: null },
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
    // Available languages — distinct across verified consultants. ORM read + JS
    // dedupe (no raw SQL): pull the verified profiles' `languages` arrays and
    // flatten/unique/sort in app code. The verified-consultant set is small enough
    // that this is cheaper than it looks and avoids a Postgres `unnest`.
    prisma.consultantProfile
      .findMany({
        where: { verificationStatus: "VERIFIED", deletedAt: null },
        select: { languages: true },
      })
      .then((rows) =>
        Array.from(new Set(rows.flatMap((r) => r.languages))).sort(),
      ),
    // Available companies (from verified consultants' work experiences)
    prisma.workExperience.findMany({
      where: {
        company: { not: "" },
        user: {
          consultantProfile: { verificationStatus: "VERIFIED", deletedAt: null },
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
    // #781 §B — soft-deleted profiles leave public surfaces
    where: { rating: { gte: 4 }, consultantProfile: { deletedAt: null } },
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

    const rows = await prisma.consultantProfile.findMany({
      // #781 §B — soft-deleted profiles leave public surfaces
      where: { verificationStatus: "VERIFIED", deletedAt: null },
      orderBy,
      take: limit,
      include: { ...consultantListInclude, ...orgMembershipInclude },
    });

    // Explicitly map to IConsultantCardData so that Prisma Decimal fields
    // (e.g. tdsRate) are never included in the payload passed to Client
    // Components. Spreading the full row crosses the Server→Client boundary
    // with non-serializable Decimal objects, which Next.js rejects.
    return rows.map(({ memberships, ...c }) => {
      const firstOrg = memberships[0]?.organization ?? null;
      return {
        id: c.id,
        rating: c.rating,
        headline: c.headline,
        experience: c.experience,
        description: c.description,
        createdAt: c.createdAt,
        isVerified: c.isVerified,
        languages: c.languages,
        user: c.user,
        domain: c.domain,
        subDomains: c.subDomains,
        tags: c.tags,
        reviews: c.reviews,
        subscriptionPlans: c.subscriptionPlans,
        organizationBadge: firstOrg
          ? {
              name: firstOrg.name,
              slug: firstOrg.slug,
              logo: firstOrg.brandingProfile?.logo ?? null,
            }
          : null,
      };
    });
  },
);
