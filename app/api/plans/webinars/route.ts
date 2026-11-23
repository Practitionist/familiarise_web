import { readJsonBody } from "@/lib/api/parse";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
  planCollaboratorConsultantSelect,
  planCollaboratorScalars,
  planConsultantSelect,
} from "@/lib/api/plans/consultant-projection";
import { publicExpertProfileWhere } from "@/lib/profiles/public-profile";
import {
  parsePlanFilters,
  buildPlanWhereClause,
  isOwnerListView,
  planListCacheHeaders,
  buildPlanOrderBy,
  paginatedResponse,
  rankAndPaginate,
  getWebinarTrendingRank,
} from "../shared/plan-filters";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { WebinarPlanSchema, maxParticipantsSchema } from "@/schemas/plans";

const WebinarRecordingFlagsSchema = WebinarPlanSchema.pick({
  recordingEnabled: true,
  shareRecordingsWithAllAttendees: true,
}).partial();

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const filters = parsePlanFilters(searchParams);
    const { sort, page, limit, skip } = filters;
    const ownerView = await isOwnerListView(filters);
    const headers = planListCacheHeaders(filters);
    const where = buildPlanWhereClause(filters, {
      ownerView,
    }) as Prisma.WebinarPlanWhereInput;
    const orderBy = buildPlanOrderBy(sort) as
      Prisma.WebinarPlanOrderByWithRelationInput | undefined;

    // The list never carries who holds a seat: that is the viewer's own business.
    const include: Record<string, unknown> = {
      consultantProfile: { select: planConsultantSelect },
      topics: true,
      collaborators: {
        // The owner's own list keeps the whole team; anyone else sees public profiles only.
        where: {
          status: "ACCEPTED",
          ...(!ownerView && { consultantProfile: publicExpertProfileWhere }),
        },
        select: {
          ...planCollaboratorScalars,
          consultantProfile: { select: planCollaboratorConsultantSelect },
        },
      },
    };

    // For trending sort, use a two-step Prisma approach:
    // 1. Ranked ids from the cached 60s scan (IDs + nested slot IDs only)
    // 2. Fetch full plan data only for the paginated slice
    if (sort === "trending") {
      const ranked = await getWebinarTrendingRank(JSON.stringify(where));

      // Awaited so a failed page fetch reaches this catch and its capture.
      return await rankAndPaginate(
        ranked,
        (ids) =>
          prisma.webinarPlan.findMany({
            where: { ...where, id: { in: ids } },
            include,
          }),
        skip,
        limit,
        page,
        headers,
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

    return paginatedResponse(webinarPlans, total, page, limit, headers);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error fetching webinar plans:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinar plans" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const body = read.body;
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
      topicIds,
    } = body;
    const recordingFlags = WebinarRecordingFlagsSchema.safeParse(body);
    if (!recordingFlags.success) {
      return NextResponse.json(
        { error: "Invalid recording settings" },
        { status: 400 },
      );
    }

    // Ownership: non-privileged users can only create plans for themselves
    const consultantProfileId = isPrivileged(session.user.role)
      ? body.consultantProfileId
      : session.user.consultantProfileId;

    if (!consultantProfileId) {
      return forbiddenResponse(
        "You must have a consultant profile to create a webinar plan",
      );
    }

    // Input validation
    if (!title || !durationInHours || !price || !maxParticipants) {
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

    const capacity = maxParticipantsSchema.safeParse(maxParticipants);
    if (!capacity.success) {
      return NextResponse.json(
        { error: capacity.error.issues[0]?.message ?? "Invalid capacity" },
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
        recordingEnabled: recordingFlags.data.recordingEnabled ?? false,
        shareRecordingsWithAllAttendees:
          recordingFlags.data.shareRecordingsWithAllAttendees ?? false,
        consultantProfile: { connect: { id: consultantProfileId } },
        topics: topicIds
          ? { connect: topicIds.map((id: string) => ({ id })) }
          : undefined,
      },
      include: {
        consultantProfile: { select: planConsultantSelect },
        topics: true,
      },
    });

    return NextResponse.json({ data: newWebinarPlan }, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error creating webinar plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar plan" },
      { status: 500 },
    );
  }
}
