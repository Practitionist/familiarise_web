import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

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
      default:
        orderBy = { user: { name: "asc" } };
    }

    // Fetch consultants with pagination
    const consultants = await prisma.consultantProfile.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
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

    // Get total count for pagination
    const total = await prisma.consultantProfile.count({ where });

    return NextResponse.json({
      data: consultants,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching consultants:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
