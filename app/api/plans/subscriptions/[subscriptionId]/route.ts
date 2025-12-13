import prisma from "@/lib/prisma";
import { Prisma, PlanEmailSupport } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

interface UpdateSubscriptionPlanRequest {
  title?: string;
  description?: string;
  durationInMonths?: number;
  price?: number;
  callsPerWeek?: number;
  sessionDurationInHours?: number;
  emailSupport?: PlanEmailSupport;
  language?: string;
  level?: string;
  prerequisites?: string;
  materialProvided?: string;
  learningOutcomes?: string[];
  consultantProfileId?: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const subscriptionPlan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
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
        subscriptions: {
          include: {
            requestedBy: {
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
          },
        },
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    console.error("Error fetching subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription plan" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const body: UpdateSubscriptionPlanRequest = await request.json();

    // Input validation
    if (body.durationInMonths && body.durationInMonths <= 0) {
      return NextResponse.json(
        { error: "Duration must be a positive number" },
        { status: 400 },
      );
    }

    if (body.price && body.price <= 0) {
      return NextResponse.json(
        { error: "Price must be a positive number" },
        { status: 400 },
      );
    }

    if (body.callsPerWeek && body.callsPerWeek < 0) {
      return NextResponse.json(
        { error: "Calls per week must be a non-negative number" },
        { status: 400 },
      );
    }

    if (
      body.emailSupport &&
      !Object.values(PlanEmailSupport).includes(body.emailSupport)
    ) {
      return NextResponse.json(
        { error: "Invalid email support value" },
        { status: 400 },
      );
    }

    // Recompute derived metrics if base fields are being updated
    let totalSessions: number | undefined;
    let totalHours: number | undefined;

    if (
      body.callsPerWeek !== undefined ||
      body.durationInMonths !== undefined ||
      body.sessionDurationInHours !== undefined
    ) {
      // Fetch existing plan to get current values for fields not being updated
      const existingPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: subscriptionId },
        select: {
          callsPerWeek: true,
          durationInMonths: true,
          sessionDurationInHours: true,
        },
      });

      if (existingPlan) {
        const callsPerWeek = body.callsPerWeek ?? existingPlan.callsPerWeek;
        const durationInMonths =
          body.durationInMonths ?? existingPlan.durationInMonths;
        const sessionDurationInHours =
          body.sessionDurationInHours ?? existingPlan.sessionDurationInHours;

        totalSessions = callsPerWeek * durationInMonths * 4;
        totalHours = totalSessions * sessionDurationInHours;
      }
    }

    const subscriptionPlan = await prisma.subscriptionPlan.update({
      where: { id: subscriptionId },
      data: {
        title: body.title,
        description: body.description,
        durationInMonths: body.durationInMonths,
        price: body.price ? Math.round(body.price) : undefined, // Ensure price is an integer
        callsPerWeek: body.callsPerWeek,
        sessionDurationInHours: body.sessionDurationInHours,
        totalSessions,
        totalHours,
        emailSupport: body.emailSupport,
        language: body.language,
        level: body.level,
        prerequisites: body.prerequisites,
        materialProvided: body.materialProvided,
        learningOutcomes: body.learningOutcomes,
        consultantProfile: body.consultantProfileId
          ? {
              connect: { id: body.consultantProfileId },
            }
          : undefined,
      },
      include: {
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
        subscriptions: {
          include: {
            requestedBy: {
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
          },
        },
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    console.error("Error updating subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;

    // Check if there are any associated subscriptions
    const associatedSubscriptions = await prisma.subscription.findMany({
      where: { subscriptionPlanId: subscriptionId },
    });

    if (associatedSubscriptions.length > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete subscription plan with associated subscriptions",
        },
        { status: 400 },
      );
    }

    const subscriptionPlan = await prisma.subscriptionPlan.delete({
      where: { id: subscriptionId },
      include: {
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
      },
    });

    return NextResponse.json({ data: subscriptionPlan }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }
    console.error("Error deleting subscription plan:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the subscription plan" },
      { status: 500 },
    );
  }
}
