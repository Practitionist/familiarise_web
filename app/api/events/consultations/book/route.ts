import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";
import { acquireLock, releaseLock, checkRateLimit } from "@/lib/redis";

export async function POST(req: NextRequest) {
  const lockKey = "consultation-booking-lock";
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
    const { consultationPlanId, slotStartTimeInUTC, slotEndTimeInUTC, notes } =
      data;

    if (!consultationPlanId || !slotStartTimeInUTC || !slotEndTimeInUTC) {
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

    // Get consultation plan details to check consultant
    const consultationPlan = await prisma.consultationPlan.findUnique({
      where: { id: consultationPlanId },
      include: {
        consultantProfile: true,
      },
    });

    if (!consultationPlan?.consultantProfile?.id) {
      return NextResponse.json(
        { error: "Invalid consultation plan" },
        {
          status: 400,
        },
      );
    }

    // Check for overlapping appointments
    const hasOverlap = await checkOverlappingAppointments(
      new Date(slotStartTimeInUTC),
      new Date(slotEndTimeInUTC),
      consultationPlan.consultantProfile.id,
    );

    if (hasOverlap) {
      return NextResponse.json(
        { error: "Time slot overlaps with existing appointment" },
        {
          status: 400,
        },
      );
    }

    // Create consultation and appointment in a transaction
    const appointment = await prisma.$transaction(async (tx) => {
      // Create consultation request
      const consultation = await tx.consultation.create({
        data: {
          consultationPlan: {
            connect: {
              id: consultationPlanId,
            },
          },
          requestedBy: {
            connect: {
              id: user.consulteeProfile?.id,
            },
          },
          requestNotes: notes,
          directlyBooked: true,
        },
      });

      // Create appointment
      return await tx.appointment.create({
        data: {
          appointmentType: AppointmentsType.CONSULTATION,
          consultation: {
            connect: {
              id: consultation.id,
            },
          },
          slotOfAppointment: {
            create: {
              userId: user.id,
              slotStartTimeInUTC: new Date(slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(slotEndTimeInUTC),
            },
          },
        },
        include: {
          slotOfAppointment: {
            include: {
              user: true,
            },
          },
          consultation: {
            include: {
              consultationPlan: {
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
    console.error("Error booking consultation:", error);
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
