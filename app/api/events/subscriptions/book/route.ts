import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { checkOverlappingAppointments } from "@/utils/appointmentUtils";
import { acquireLock, releaseLock, checkRateLimit } from "@/lib/redis";

export async function POST(req: NextRequest) {
  const lockKey = "subscription-booking-lock";
  let hasLock = false;

  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { error: "Unauthorized" },
        {
          status: 401,
        },
      );
    }

    // Check rate limit
    const identifier = `booking:${session.user.email}`;
    const isAllowed = await checkRateLimit(identifier);
    if (!isAllowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
        },
      );
    }

    const data = await req.json();
    const {
      subscriptionPlanId,
      startDate,
      endDate,
      slotStartTimeInUTC,
      slotEndTimeInUTC,
      notes,
      schedule,
    } = data;

    if (
      !subscriptionPlanId ||
      !startDate ||
      !endDate ||
      !slotStartTimeInUTC ||
      !slotEndTimeInUTC ||
      !schedule
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        {
          status: 400,
        },
      );
    }

    // Acquire distributed lock
    hasLock = await acquireLock(lockKey);
    if (!hasLock) {
      return NextResponse.json(
        { error: "Service is busy. Please try again." },
        {
          status: 409,
        },
      );
    }

    const user = await prisma.user.findUnique({
      where: {
        email: session.user.email,
      },
      include: {
        consulteeProfile: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        {
          status: 404,
        },
      );
    }

    // Get subscription plan details to check consultant
    const subscriptionPlan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      include: {
        consultantProfile: true,
      },
    });

    if (!subscriptionPlan?.consultantProfile?.id) {
      return NextResponse.json(
        { error: "Invalid subscription plan" },
        {
          status: 400,
        },
      );
    }

    // Check for overlapping appointments
    const hasOverlap = await checkOverlappingAppointments(
      new Date(slotStartTimeInUTC),
      new Date(slotEndTimeInUTC),
      subscriptionPlan.consultantProfile.id,
    );

    if (hasOverlap) {
      return NextResponse.json(
        { error: "Time slot overlaps with existing appointment" },
        {
          status: 400,
        },
      );
    }

    // Create subscription and appointment in a transaction
    const appointment = await prisma.$transaction(async (tx) => {
      // Create subscription request
      const subscription = await tx.subscription.create({
        data: {
          subscriptionPlan: {
            connect: {
              id: subscriptionPlanId,
            },
          },
          requestedBy: {
            connect: {
              id: user.consulteeProfile?.id,
            },
          },
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          requestNotes: notes,
        },
      });

      // Create initial appointment
      return await tx.appointment.create({
        data: {
          appointmentType: AppointmentsType.SUBSCRIPTION,
          subscription: {
            connect: {
              id: subscription.id,
            },
          },
          slotsOfAppointment: {
            create: {
              user: {
                connect: {
                  id: user.id,
                },
              },
              slotStartTimeInUTC: new Date(slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(slotEndTimeInUTC),
            },
          },
        },
        include: {
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: {
                  consultantProfile: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
              requestedBy: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    });

    return NextResponse.json(appointment);
  } catch (error: any) {
    console.error("Error booking subscription:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      {
        status: 500,
      },
    );
  } finally {
    // Release the lock if we acquired it
    if (hasLock) {
      await releaseLock(lockKey);
    }
  }
}
