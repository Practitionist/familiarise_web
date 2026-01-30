import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";
    const skip = (page - 1) * limit;

    // New filter params
    const topicIds = searchParams.get("topicIds");
    const language = searchParams.get("language");
    const domainId = searchParams.get("domainId");
    const sort = searchParams.get("sort");
    const minPrice = searchParams.get("minPrice");
    const maxPrice = searchParams.get("maxPrice");
    const search = searchParams.get("search");

    // Build where clause
    const where: Prisma.WebinarPlanWhereInput = {};
    if (consultantId) {
      where.consultantProfileId = consultantId;
    }
    if (language) {
      where.language = language;
    }
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = parseInt(minPrice);
      if (maxPrice) where.price.lte = parseInt(maxPrice);
    }
    if (search) {
      where.title = { contains: search, mode: "insensitive" };
    }
    if (topicIds) {
      const ids = topicIds.split(",").filter(Boolean);
      if (ids.length > 0) {
        where.topics = { some: { id: { in: ids } } };
      }
    }
    if (domainId) {
      where.consultantProfile = { domainId };
    }

    // Build orderBy clause
    let orderBy: Prisma.WebinarPlanOrderByWithRelationInput | undefined;
    if (sort === "newest") {
      orderBy = { createdAt: "desc" };
    } else if (sort === "price-asc") {
      orderBy = { price: "asc" };
    } else if (sort === "price-desc") {
      orderBy = { price: "desc" };
    } else if (sort === "title-asc") {
      orderBy = { title: "asc" };
    } else if (sort === "title-desc") {
      orderBy = { title: "desc" };
    }

    // Build include object based on whether registration data is requested
    const include: Record<string, unknown> = {
      consultantProfile: true,
      topics: true,
    };

    if (includeRegistration) {
      include.webinars = {
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: { select: { id: true } },
                },
              },
            },
          },
        },
      };
    }

    // For trending sort, use a two-step Prisma approach:
    // 1. Lightweight select (IDs + nested slot IDs only) to rank by enrollment count
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Step 1: Fetch only IDs and minimal nested data for counting
      const plansForRanking = await prisma.webinarPlan.findMany({
        where,
        select: {
          id: true,
          webinars: {
            select: {
              appointment: {
                select: {
                  slotsOfAppointment: {
                    where: { createdAt: { gte: thirtyDaysAgo } },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      });

      // Rank by recent enrollment count
      const ranked = plansForRanking
        .map((p) => ({
          id: p.id,
          count: p.webinars.reduce(
            (sum, w) =>
              sum + (w.appointment?.slotsOfAppointment?.length ?? 0),
            0,
          ),
        }))
        .sort((a, b) => b.count - a.count);

      const total = ranked.length;
      const paginatedIds = ranked.slice(skip, skip + limit).map((r) => r.id);

      // Step 2: Fetch full data only for the paginated IDs
      const webinarPlans =
        paginatedIds.length > 0
          ? await prisma.webinarPlan.findMany({
              where: { ...where, id: { in: paginatedIds } },
              include,
            })
          : [];

      // Re-sort to match the ranking order
      const idOrder = new Map(paginatedIds.map((id, i) => [id, i]));
      webinarPlans.sort(
        (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
      );

      return NextResponse.json(
        {
          data: webinarPlans,
          meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
        { status: 200 },
      );
    }

    const [webinarPlans, total] = await Promise.all([
      prisma.webinarPlan.findMany({
        where,
        include,
        skip,
        take: limit,
        ...(orderBy && { orderBy }),
      }),
      prisma.webinarPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: webinarPlans,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching webinar plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinar plans" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      description,
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInHours ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (durationInHours <= 0 || price <= 0 || maxParticipants <= 0) {
      return NextResponse.json(
        { error: "Invalid numeric values" },
        { status: 400 },
      );
    }

    const newWebinarPlan = await prisma.webinarPlan.create({
      data: {
        title,
        description,
        durationInHours,
        price,
        maxParticipants,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
      },
      include: {
        consultantProfile: true,
        topics: true,
      },
    });

    return NextResponse.json({ data: newWebinarPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar plan" },
      { status: 500 },
    );
  }
}
