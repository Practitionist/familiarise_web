import prisma from "@/lib/prisma";
import { Prisma, TrialSessionStatus, AppointmentsType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { logTrialRequested } from "@/lib/activity/log-activity";

/**
 * GET /api/trials
 * List trial sessions with optional filters
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as TrialSessionStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: Prisma.TrialSessionWhereInput = {};

    if (consultantProfileId) {
      whereClause.consultantProfileId = consultantProfileId;
    }

    if (consulteeProfileId) {
      whereClause.consulteeProfileId = consulteeProfileId;
    }

    if (status) {
      whereClause.status = status;
    }

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
        orderBy: {
          requestedAt: "desc",
        },
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

interface CreateTrialRequest {
  consulteeProfileId: string;
  consultantProfileId: string;
  subscriptionPlanId: string;
  notes?: string;
}

/**
 * POST /api/trials
 * Request a new trial session
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateTrialRequest;

    const { consulteeProfileId, consultantProfileId, subscriptionPlanId, notes } = body;

    if (!consulteeProfileId || !consultantProfileId || !subscriptionPlanId) {
      return NextResponse.json(
        { error: "consulteeProfileId, consultantProfileId, and subscriptionPlanId are required" },
        { status: 400 }
      );
    }

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

    return NextResponse.json({ data: trialSession }, { status: 201 });
  } catch (error) {
    console.error("Error creating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while creating trial session" },
      { status: 500 }
    );
  }
}
