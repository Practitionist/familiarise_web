import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import { NextRequest, NextResponse } from "next/server";
import { CollaboratorStatus, PlanEmailSupport, Prisma } from "@prisma/client";
import {
  planCollaboratorConsultantSelect,
  planConsultantSelect,
} from "@/lib/api/plans/consultant-projection";
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
    const includeCohorts = searchParams.get("include")?.includes("cohorts");
    const includeRegistration =
      searchParams.get("includeRegistration") === "true";

    const filters = parsePlanFilters(searchParams);
    const { sort, page, limit, skip } = filters;
    const where = buildPlanWhereClause(filters) as Prisma.CohortPlanWhereInput;
    const orderBy = buildPlanOrderBy(sort) as
      | Prisma.CohortPlanOrderByWithRelationInput
      | undefined;

    // Build classes include based on whether registration data is requested
    let cohortsInclude: boolean | Record<string, unknown> = true;
    if (includeRegistration) {
      cohortsInclude = {
        include: {
          appointment: {
            include: {
              // #1554 — seat ids only; the explore card's enrolment check.
              participants: {
                where: liveParticipant(),
                select: { userId: true },
              },
            },
          },
        },
      };
    }

    const includeOptions = {
      consultantProfile: { select: planConsultantSelect },
      topics: true,
      cohortContents: true,
      collaborators: {
        where: { status: CollaboratorStatus.ACCEPTED },
        include: {
          consultantProfile: { select: planCollaboratorConsultantSelect },
        },
      },
      ...((includeCohorts || includeRegistration) && {
        cohorts: cohortsInclude,
      }),
    };

    // For trending sort, use a two-step Prisma approach:
    // 1. Lightweight select (IDs + nested slot rows only) to rank by how many
    //    SESSIONS the plan's classes had scheduled in the window
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const plansForRanking = await prisma.cohortPlan.findMany({
        where,
        select: {
          id: true,
          cohorts: {
            select: {
              appointment: {
                select: {
                  id: true,
                  // #1554 — one row per held call, so the count is the rows.
                  _count: {
                    select: {
                      occurrences: {
                        where: {
                          createdAt: { gte: thirtyDaysAgo },
                          deletedAt: null,
                          completionStatus: {
                            notIn: ["CANCELLED", "RESCHEDULED"],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // The ranking measures how much of a plan is running: one occurrence
      // row is one held call (#1554), so the live rows are the count.
      const ranked = plansForRanking
        .map((p) => ({
          id: p.id,
          count: p.cohorts.reduce(
            (sum, cls) => sum + (cls.appointment?._count.occurrences ?? 0),
            0,
          ),
        }))
        .sort((a, b) => b.count - a.count);

      return rankAndPaginate(
        ranked,
        (ids) =>
          prisma.cohortPlan.findMany({
            where: { ...where, id: { in: ids } },
            include: includeOptions,
          }),
        skip,
        limit,
        page,
      );
    }

    const [cohortPlans, total] = await Promise.all([
      prisma.cohortPlan.findMany({
        where,
        include: includeOptions,
        skip,
        take: limit,
        ...(orderBy && { orderBy }),
      }),
      prisma.cohortPlan.count({ where }),
    ]);

    return paginatedResponse(cohortPlans, total, page, limit);
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
      cohortContents,
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

    // `body` is untyped JSON and the required-field check above never asked for
    // `cohortContents`, so a request that omitted it threw inside the mapper
    // below and the caller was told 500 for a malformed request. Absent means
    // no curriculum rows; present-but-not-a-list is the client's error.
    if (cohortContents !== undefined && !Array.isArray(cohortContents)) {
      return NextResponse.json(
        { error: "cohortContents must be an array" },
        { status: 400 },
      );
    }

    const newCohortPlan = await prisma.cohortPlan.create({
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
        cohortContents: {
          create: (cohortContents ?? []).map(
            (content: Prisma.CohortContentCreateWithoutCohortPlanInput) => ({
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
        cohortContents: true,
      },
    });

    return NextResponse.json({ data: newCohortPlan }, { status: 201 });
  } catch (error) {
    console.error("Error creating class plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the class plan" },
      { status: 500 },
    );
  }
}
