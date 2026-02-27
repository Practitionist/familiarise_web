import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consultantListInclude } from "@/lib/data/explore-experts";
import { apiError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
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
    const availability = searchParams.get("availability") as
      | "has_slots"
      | "this_week"
      | null;

    const minPrice = rawMinPrice ? parseFloat(rawMinPrice) : undefined;
    const maxPrice = rawMaxPrice ? parseFloat(rawMaxPrice) : undefined;

    // Calculate offset
    const skip = (page - 1) * limit;

    // Check if this is an admin/staff request (can see all) or public (only verified)
    const includeUnverified = searchParams.get("includeUnverified") === "true";

    // Build where clause
    const where: any = {
      AND: [],
    };

    // Only show verified consultants in public listings
    if (!includeUnverified) {
      where.AND.push({ verificationStatus: "VERIFIED" });
    }

    // Domain filter
    if (domain) {
      where.AND.push({ domainId: domain });
    }

    // Subdomain filter
    if (subdomain) {
      where.AND.push({
        subDomains: {
          some: {
            id: subdomain,
          },
        },
      });
    }

    // Tags filter
    if (tags && tags.length > 0) {
      where.AND.push({
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
      where.AND.push({
        experience: {
          gte: experience,
        },
      });
    }

    // Price filter (via subscription plans)
    if (minPrice !== undefined && !isNaN(minPrice)) {
      where.AND.push({
        subscriptionPlans: { some: { price: { gte: minPrice } } },
      });
    }
    if (maxPrice !== undefined && !isNaN(maxPrice)) {
      where.AND.push({
        subscriptionPlans: { some: { price: { lte: maxPrice } } },
      });
    }

    // Availability filter
    if (availability === "has_slots") {
      where.AND.push({
        OR: [
          { slotsOfAvailabilityWeekly: { some: {} } },
          { slotsOfAvailabilityCustom: { some: {} } },
        ],
      });
    } else if (availability === "this_week") {
      const now = new Date();
      const oneWeekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      where.AND.push({
        OR: [
          // Weekly slots are recurring — if they exist, the consultant
          // has availability every week
          { slotsOfAvailabilityWeekly: { some: {} } },
          // Custom slots within the next 7 days
          {
            slotsOfAvailabilityCustom: {
              some: {
                availabilityStartsAt: {
                  gte: now,
                  lte: oneWeekFromNow,
                },
              },
            },
          },
        ],
      });
    }

    // Language filter
    if (language) {
      where.AND.push({ languages: { has: language } });
    }

    // Search filter
    if (search) {
      where.AND.push({
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

    // If no filters are applied, remove the AND array
    if (where.AND.length === 0) {
      delete where.AND;
    }

    // Build orderBy clause
    let orderBy: any = {};
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
      include: consultantListInclude,
    });

    // Get total count for pagination
    const total = await prisma.consultantProfile.count({ where });

    return NextResponse.json(
      {
        data: consultants,
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
