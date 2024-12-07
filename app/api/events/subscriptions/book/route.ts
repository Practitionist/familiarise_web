import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import authOptions from "@/app/api/auth/[...nextauth]/options";

interface BookSubscriptionRequest {
  subscriptionPlanId: string;
  tentativeStartDate: string;
  tentativeSchedule?: string;
  requestNotes?: string;
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      subscriptionPlanId,
      tentativeStartDate,
      tentativeSchedule,
      requestNotes,
    }: BookSubscriptionRequest = await request.json();

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
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
    });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
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

    if (!subscriptionPlan) {
      return NextResponse.json(
        { error: "Subscription plan not found" },
        { status: 404 },
      );
    }

    const endDate = new Date(tentativeStartDate);
    endDate.setMonth(endDate.getMonth() + subscriptionPlan.durationInMonths);

    const subscription = await prisma.subscription.create({
      data: {
        subscriptionPlan: { connect: { id: subscriptionPlanId } },
        requestedBy: { connect: { id: consultee.id } },
        startDate: new Date(tentativeStartDate),
        endDate: endDate,
        tentativeStartDate: new Date(tentativeStartDate),
        tentativeSchedule,
        requestNotes,
        requestStatus: "PENDING",
      },
      include: {
        subscriptionPlan: {
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
        },
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
    });

    // We don't create appointments here as they will be created by the consultant upon approval

    return NextResponse.json({ subscription }, { status: 201 });
  } catch (error) {
    console.error("Error booking subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while booking the subscription" },
      { status: 500 },
    );
  }
}
