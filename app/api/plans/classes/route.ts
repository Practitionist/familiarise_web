import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { CollaboratorStatus, PlanEmailSupport, Prisma } from "@prisma/client";
import {
  parsePlanFilters,
  buildPlanWhereClause,
  buildPlanOrderBy,
  paginatedResponse,
  rankAndPaginate,
} from "../shared/plan-filters";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeClasses = searchParams.get("include")?.includes("classes");
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";

    const filters = parsePlanFilters(searchParams);
    const { sort, page, limit, skip } = filters;
    const where = buildPlanWhereClause(filters) as Prisma.ClassPlanWhereInput;
    const orderBy = buildPlanOrderBy(sort) as
      | Prisma.ClassPlanOrderByWithRelationInput
      | undefined;

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
      consultantProfile: {
        include: {
          user: {
            select: {
              name: true,
              image: true,
              workExperiences: {
                select: {
                  company: true,
                  companyDomain: true,
                  isCurrent: true,
                },
                orderBy: [
                  { isCurrent: "desc" as const },
                  { startDate: "desc" as const },
                ],
                take: 3,
              },
            },
          },
        },
      },
      topics: true,
      classContents: true,
      collaborators: {
        where: { status: CollaboratorStatus.ACCEPTED },
        include: {
          consultantProfile: {
            include: {
              user: {
                select: {
                  name: true,
                  image: true,
                  workExperiences: {
                    select: {
                      company: true,
                      companyDomain: true,
                      isCurrent: true,
                    },
                    orderBy: [
                      { isCurrent: "desc" as const },
                      { startDate: "desc" as const },
                    ],
                    take: 3,
                  },
                },
              },
            },
          },
        },
      },
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

      return rankAndPaginate(
        ranked,
        (ids) =>
          prisma.classPlan.findMany({
            where: { ...where, id: { in: ids } },
            include: includeOptions,
          }),
        skip,
        limit,
        page,
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

    return paginatedResponse(classPlans, total, page, limit);
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
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const body = await request.json();
    const {
      title,
      description,
      durationInMonths,
      price,
      sessionsPerWeek,
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
      recordingEnabled,
      recordingStoragePolicy,
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

    // Authorization: verify consultantProfileId matches session user's profile
    // (unless privileged user creating on behalf of another)
    if (!isPrivileged(session.user.role)) {
      if (session.user.consultantProfileId !== consultantProfileId) {
        return forbiddenResponse(
          "You can only create class plans for your own consultant profile",
        );
      }
    }

    if (
      durationInMonths <= 0 ||
      price <= 0 ||
      sessionsPerWeek < 0 ||
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
        sessionsPerWeek,
        sessionDurationInHours: sessionDurationInHours || 1,
        emailSupport,
        maxParticipants,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        recordingEnabled: recordingEnabled ?? false,
        recordingStoragePolicy: recordingStoragePolicy ?? "STREAM_ONLY",
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
        classContents: {
          create: classContents.map(
            (content: Prisma.ClassContentCreateWithoutClassPlanInput) => ({
              title: content.title,
              description: content.description,
              contentType: content.contentType,
              contentUrl: content.contentUrl,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
            }),
          ),
        },
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                name: true,
                image: true,
                workExperiences: {
                  select: {
                    company: true,
                    companyDomain: true,
                    isCurrent: true,
                  },
                  orderBy: [
                    { isCurrent: "desc" as const },
                    { startDate: "desc" as const },
                  ],
                  take: 3,
                },
              },
            },
          },
        },
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
