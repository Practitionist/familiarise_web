import { readJsonBody } from "@/lib/api/parse";
import prisma from "@/lib/prisma";
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
  getClassTrendingRank,
} from "../shared/plan-filters";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { maxParticipantsSchema, PlanCadenceSchema } from "@/schemas/plans";
import { planTotalSessions } from "@/lib/booking/entitlement";
import { reportSentryError } from "@/lib/observability/report";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeClasses = searchParams.get("include")?.includes("classes");

    const filters = parsePlanFilters(searchParams);
    const { sort, page, limit, skip } = filters;
    const where = buildPlanWhereClause(filters) as Prisma.ClassPlanWhereInput;
    const orderBy = buildPlanOrderBy(sort) as
      Prisma.ClassPlanOrderByWithRelationInput | undefined;

    const includeOptions = {
      consultantProfile: { select: planConsultantSelect },
      topics: true,
      classContents: true,
      collaborators: {
        where: { status: CollaboratorStatus.ACCEPTED },
        include: {
          consultantProfile: { select: planCollaboratorConsultantSelect },
        },
      },
      ...(includeClasses && { classes: true }),
    };

    // For trending sort, use a two-step Prisma approach:
    // 1. Ranked ids from the cached 60s scan
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const ranked = await getClassTrendingRank(JSON.stringify(where));

      // Awaited so a failed page fetch reaches this catch and its capture.
      return await rankAndPaginate(
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
    reportSentryError(error, {
      subsystem: "plans",
      op: "class-plans.list",
      expected: false,
    });
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

    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const body = read.body;
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

    // The same cadence rules as the plan editor: a 0 or fractional cadence, or a
    // length off the 30-minute grid, is the client's error, never a DB 500.
    const cadence = PlanCadenceSchema.safeParse({
      sessionsPerWeek,
      sessionDurationInHours: sessionDurationInHours ?? 1,
    });
    if (!cadence.success) {
      return NextResponse.json(
        { error: cadence.error.issues[0]?.message ?? "Invalid cadence" },
        { status: 400 },
      );
    }

    const capacity = maxParticipantsSchema.safeParse(maxParticipants);
    if (!capacity.success) {
      return NextResponse.json(
        { error: capacity.error.issues[0]?.message ?? "Invalid capacity" },
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
    // `classContents`, so a request that omitted it threw inside the mapper
    // below and the caller was told 500 for a malformed request. Absent means
    // no curriculum rows; present-but-not-a-list is the client's error.
    if (classContents !== undefined && !Array.isArray(classContents)) {
      return NextResponse.json(
        { error: "classContents must be an array" },
        { status: 400 },
      );
    }

    const totalSessions = planTotalSessions({
      sessionsPerWeek: sessionsPerWeek ?? 1,
      durationInMonths,
    });
    const newClassPlan = await prisma.classPlan.create({
      data: {
        title,
        description,
        durationInMonths,
        price,
        sessionsPerWeek,
        sessionDurationInHours: sessionDurationInHours || 1,
        totalSessions,
        totalHours: totalSessions * (sessionDurationInHours || 1),
        emailSupport,
        maxParticipants,
        language,
        level,
        prerequisites,
        materialProvided,
        learningOutcomes,
        recordingEnabled: recordingEnabled ?? false,
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
        classContents: {
          create: (classContents ?? []).map(
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
        consultantProfile: { select: planConsultantSelect },
        topics: true,
        classContents: true,
      },
    });

    return NextResponse.json({ data: newClassPlan }, { status: 201 });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "plans",
      op: "class-plans.create",
      expected: false,
    });
    return NextResponse.json(
      { error: "An error occurred while creating the class plan" },
      { status: 500 },
    );
  }
}
