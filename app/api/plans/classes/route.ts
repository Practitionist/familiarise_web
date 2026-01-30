import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { PlanEmailSupport, Prisma } from "@prisma/client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const consultantId = searchParams.get("consultantId");
    const includeClasses = searchParams.get("include")?.includes("classes");
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
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
    const where: Prisma.ClassPlanWhereInput = {};
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
    let orderBy: Prisma.ClassPlanOrderByWithRelationInput | undefined;
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

    // Build classes include based on whether registration data is requested
    let classesInclude: boolean | Record<string, unknown> = true;
    if (includeRegistration) {
      classesInclude = {
        include: {
          appointments: {
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

    const includeOptions = {
      consultantProfile: true,
      topics: true,
      classContents: true,
      ...((includeClasses || includeRegistration) && {
        classes: classesInclude,
      }),
    };

    // For trending sort, use a two-step Prisma approach:
    // 1. Lightweight select (IDs + nested slot IDs only) to rank by enrollment count
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Step 1: Fetch only IDs and minimal nested data for counting
      const plansForRanking = await prisma.classPlan.findMany({
        where,
        select: {
          id: true,
          classes: {
            select: {
              appointments: {
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
          count: p.classes.reduce(
            (sum, cls) =>
              sum +
              cls.appointments.reduce(
                (s, apt) => s + apt.slotsOfAppointment.length,
                0,
              ),
            0,
          ),
        }))
        .sort((a, b) => b.count - a.count);

      const total = ranked.length;
      const paginatedIds = ranked.slice(skip, skip + limit).map((r) => r.id);

      // Step 2: Fetch full data only for the paginated IDs
      const classPlans =
        paginatedIds.length > 0
          ? await prisma.classPlan.findMany({
              where: { ...where, id: { in: paginatedIds } },
              include: includeOptions,
            })
          : [];

      // Re-sort to match the ranking order
      const idOrder = new Map(paginatedIds.map((id, i) => [id, i]));
      classPlans.sort(
        (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
      );

      return NextResponse.json(
        {
          data: classPlans,
          meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
        { status: 200 },
      );
    }

    const [classPlans, total] = await Promise.all([
      prisma.classPlan.findMany({
        where,
        include: includeOptions,
        skip,
        take: limit,
        ...(orderBy && { orderBy }),
      }),
      prisma.classPlan.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: classPlans,
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
    console.error("Error fetching class plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching class plans" },
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
      durationInMonths,
      price,
      meetingsPerWeek,
      sessionDurationInHours,
      emailSupport,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      classContents,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInMonths ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      durationInMonths <= 0 ||
      price <= 0 ||
      meetingsPerWeek < 0 ||
      (sessionDurationInHours && sessionDurationInHours <= 0) ||
      maxParticipants <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid numeric values" },
        { status: 400 },
      );
    }

    if (!Object.values(PlanEmailSupport).includes(emailSupport)) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 },
      );
    }

    const newClassPlan = await prisma.classPlan.create({
      data: {
        title,
        description,
        durationInMonths,
        price,
        meetingsPerWeek,
        sessionDurationInHours: sessionDurationInHours || 1,
        emailSupport,
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
        classContents: {
          create: classContents.map((content: any) => ({
            title: content.title,
            description: content.description,
            contentType: content.contentType,
            contentUrl: content.contentUrl,
            order: content.order,
            hoursAllotted: content.hoursAllotted,
          })),
        },
      },
      include: {
        consultantProfile: true,
        topics: true,
        classContents: true,
      },
    });

    return NextResponse.json({ data: newClassPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the class plan" },
      { status: 500 },
    );
  }
}
