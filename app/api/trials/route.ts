import prisma from "@/lib/prisma";
import { Prisma, TrialSessionStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { logTrialRequested } from "@/lib/activity/log-activity";
import { notifyTrialSessionRequested } from "@/lib/novu";
import { CreateTrialSchema } from "@/schemas/trials";

/**
 * GET /api/trials
 * List trial sessions with optional filters
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const subscriptionPlanId = searchParams.get("subscriptionPlanId");
  const status = searchParams.get("status") as TrialSessionStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");
  const search = searchParams.get("search");
  const sortBy = searchParams.get("sortBy") || "requestedAt";
  const sortOrder = searchParams.get("sortOrder") || "desc";

  try {
    // Auto-complete scheduled trials whose end time has passed
    const now = new Date();
    await prisma.trialSession.updateMany({
      where: {
        status: TrialSessionStatus.SCHEDULED,
        appointment: {
          slotsOfAppointment: {
            some: {
              endsAt: {
                lt: now,
              },
            },
          },
        },
      },
      data: {
        status: TrialSessionStatus.COMPLETED,
        completedAt: now,
      },
    });

    const whereClause: Prisma.TrialSessionWhereInput = {};

    if (consultantProfileId) {
      whereClause.consultantProfileId = consultantProfileId;
    }

    if (consulteeProfileId) {
      whereClause.consulteeProfileId = consulteeProfileId;
    }

    if (subscriptionPlanId) {
      whereClause.subscriptionPlanId = subscriptionPlanId;
    }

    if (status) {
      whereClause.status = status;
    }

    if (search) {
      whereClause.OR = [
        { consulteeProfile: { user: { name: { contains: search, mode: "insensitive" } } } },
        { consulteeProfile: { user: { email: { contains: search, mode: "insensitive" } } } },
      ];
    }

    // Dynamic orderBy mapping
    const orderByMap: Record<string, Prisma.TrialSessionOrderByWithRelationInput> = {
      requestedAt: { requestedAt: sortOrder as "asc" | "desc" },
      status: { status: sortOrder as "asc" | "desc" },
      name: { consulteeProfile: { user: { name: sortOrder as "asc" | "desc" } } },
      plan: { subscriptionPlan: { title: sortOrder as "asc" | "desc" } },
    };
    const orderBy = orderByMap[sortBy] || orderByMap.requestedAt;

    const [trialSessions, total] = await Promise.all([
      prisma.trialSession.findMany({
        where: whereClause,
        include: {
          consulteeProfile: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          consultantProfile: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          subscriptionPlan: true,
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
          convertedToSubscription: true,
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.trialSession.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: trialSessions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching trial sessions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial sessions" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/trials
 * Request a new trial session
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = CreateTrialSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 }
      );
    }
    const { consulteeProfileId, consultantProfileId, subscriptionPlanId, notes } = result.data;

    // Check if a trial already exists for this consultee-consultant pair
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        consulteeProfileId_consultantProfileId: {
          consulteeProfileId,
          consultantProfileId,
        },
      },
    });

    if (existingTrial) {
      return NextResponse.json(
        { error: "You have already requested a trial with this consultant" },
        { status: 409 }
      );
    }

    // Verify the subscription plan exists and has free trial enabled
    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 }
      );
    }

    if (!subscriptionPlan.freeTrialEnabled) {
      return NextResponse.json(
        { error: "Free trial is not available for this plan" },
        { status: 400 }
      );
    }

    // Get consultee info for activity log
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeProfileId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 }
      );
    }

    // Create the trial session
    const trialSession = await prisma.trialSession.create({
      data: {
        consulteeProfileId,
        consultantProfileId,
        subscriptionPlanId,
        notes,
        status: TrialSessionStatus.PENDING,
      },
      include: {
        consulteeProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        subscriptionPlan: true,
      },
    });

    // Log the activity
    await logTrialRequested(
      consultantProfileId,
      trialSession.id,
      {
        id: consulteeProfile.user.id,
        name: consulteeProfile.user.name,
        image: consulteeProfile.user.image,
      },
      subscriptionPlan.title
    );

    // Notify the consultant about the new trial request
    void notifyTrialSessionRequested(
      trialSession.consultantProfile.user.id,
      {
        consultantName: trialSession.consultantProfile.user.name || "Consultant",
        consulteeName: trialSession.consulteeProfile.user.name || "User",
        planTitle: subscriptionPlan.title,
        status: trialSession.status,
        dashboardUrl: "/dashboard/consultant/trials",
      },
    );

    return NextResponse.json({ data: trialSession }, { status: 201 });
  } catch (error) {
    console.error("Error creating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while creating trial session" },
      { status: 500 }
    );
  }
}
