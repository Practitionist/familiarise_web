import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { consultantListInclude, orgMembershipInclude } from "@/lib/data/explore-experts";
import { apiError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(
      Math.max(1, parseInt(searchParams.get("limit") || "10") || 10),
      100,
    );
    const domain = searchParams.get("domain");
    const subdomain = searchParams.get("subdomain");
    const tags = searchParams.get("tags")?.split(",");
    const experience = parseInt(searchParams.get("experience") || "0");
    const search = searchParams.get("search");
    const sort = searchParams.get("sort") || "nameAsc";

    // New filter params with NaN guards
    const rawMinPrice = searchParams.get("minPrice");
    const rawMaxPrice = searchParams.get("maxPrice");
    const language = searchParams.get("language");
    const rawMinRating = searchParams.get("minRating");
    const companies = searchParams.get("companies")?.split(",").filter(Boolean);

    const minPrice = rawMinPrice ? parseFloat(rawMinPrice) : undefined;
    const maxPrice = rawMaxPrice ? parseFloat(rawMaxPrice) : undefined;
    const minRating = rawMinRating ? parseFloat(rawMinRating) : undefined;

    // Calculate offset
    const skip = (page - 1) * limit;

    // Check if this is an admin/staff request (can see all) or public (only verified)
    const includeUnverified = searchParams.get("includeUnverified") === "true";

    // Build where clause using an explicit conditions array
    const conditions: Prisma.ConsultantProfileWhereInput[] = [];

    // Only show verified consultants in public listings
    if (!includeUnverified) {
      conditions.push({ verificationStatus: "VERIFIED" });
    }

    // Domain filter
    if (domain) {
      conditions.push({ domainId: domain });
    }

    // Subdomain filter
    if (subdomain) {
      conditions.push({
        subDomains: {
          some: {
            id: subdomain,
          },
        },
      });
    }

    // Tags filter
    if (tags && tags.length > 0) {
      conditions.push({
        tags: {
          some: {
            name: {
              in: tags,
            },
          },
        },
      });
    }

    // Experience filter
    if (experience > 0) {
      conditions.push({
        experience: {
          gte: experience,
        },
      });
    }

    // Price filter (via subscription plans)
    if (minPrice !== undefined && !isNaN(minPrice)) {
      conditions.push({
        subscriptionPlans: { some: { price: { gte: minPrice } } },
      });
    }
    if (maxPrice !== undefined && !isNaN(maxPrice)) {
      conditions.push({
        subscriptionPlans: { some: { price: { lte: maxPrice } } },
      });
    }

    // Rating filter
    if (minRating !== undefined && !isNaN(minRating)) {
      conditions.push({ rating: { gte: minRating } });
    }

    // Company filter (multi-select — values come from pre-fetched list, exact match)
    if (companies && companies.length > 0) {
      conditions.push({
        user: {
          workExperiences: {
            some: { company: { in: companies } },
          },
        },
      });
    }

    // Language filter
    if (language) {
      conditions.push({ languages: { has: language } });
    }

    // Affiliation type filter: independent (isIndependent=true) or agency
    // (isIndependent=false). When null/absent, show all verified consultants.
    const affiliationType = searchParams.get("affiliationType");
    if (affiliationType === "independent") {
      conditions.push({ isIndependent: true });
    } else if (affiliationType === "agency") {
      conditions.push({ isIndependent: false });
    }

    // Search filter
    if (search) {
      conditions.push({
        OR: [
          { user: { name: { contains: search, mode: "insensitive" } } },
          { user: { email: { contains: search, mode: "insensitive" } } },
          { description: { contains: search, mode: "insensitive" } },
          { headline: { contains: search, mode: "insensitive" } },
          { domain: { name: { contains: search, mode: "insensitive" } } },
          {
            subDomains: {
              some: { name: { contains: search, mode: "insensitive" } },
            },
          },
          {
            tags: { some: { name: { contains: search, mode: "insensitive" } } },
          },
        ],
      });
    }

    // Build final where clause — only add AND if there are conditions
    const where: Prisma.ConsultantProfileWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    // Build orderBy clause
    let orderBy: Prisma.ConsultantProfileOrderByWithRelationInput = {};
    switch (sort) {
      case "nameAsc":
        orderBy = { user: { name: "asc" } };
        break;
      case "nameDesc":
        orderBy = { user: { name: "desc" } };
        break;
      case "reviewCount":
        orderBy = { reviews: { _count: "desc" } };
        break;
      case "rating":
        orderBy = { rating: "desc" };
        break;
      case "trending":
        orderBy = { reviews: { _count: "desc" } };
        break;
      case "newest":
        orderBy = { createdAt: "desc" };
        break;
      default:
        orderBy = { user: { name: "asc" } };
    }

    // Fetch consultants with pagination
    const consultants = await prisma.consultantProfile.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: { ...consultantListInclude, ...orgMembershipInclude },
    });

    // Get total count for pagination
    const total = await prisma.consultantProfile.count({ where });

    // Map memberships -> organizationBadge for frontend.
    // Arch 4-Modified: the include pulls `memberships[0].organization`
    // for the first ACTIVE EXPERT membership at a canHost org.
    // `c` is typed via Prisma's payload inference from the include shape —
    // no explicit type annotation or narrowing cast needed.
    const mappedConsultants = consultants.map(({ memberships, ...rest }) => {
      const firstOrg = memberships[0]?.organization ?? null;
      return {
        ...rest,
        organizationBadge: firstOrg
          ? {
              name: firstOrg.name,
              slug: firstOrg.slug,
              logo: firstOrg.brandingProfile?.logo ?? null,
            }
          : null,
      };
    });

    return NextResponse.json(
      {
        data: mappedConsultants,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return apiError({ tag: "[Consultants.GET]", error });
  }
}
