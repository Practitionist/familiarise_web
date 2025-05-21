import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { checkOverlappingAppointments } from "@/utils/appointmentUtils";
import { acquireLock, releaseLock, checkRateLimit } from "@/lib/redis";

export async function POST(req: NextRequest) {
  const lockKey = "class-booking-lock";
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
    const { classId, slotStartTimeInUTC, slotEndTimeInUTC } = data;

    if (!classId || !slotStartTimeInUTC || !slotEndTimeInUTC) {
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
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        {
          status: 404,
        },
      );
    }

    // Get class details to check consultant and capacity
    const classDetails = await prisma.class.findUnique({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            consultantProfile: true,
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
      },
    });

    if (!classDetails?.classPlan?.consultantProfile?.id) {
      return NextResponse.json(
        { error: "Invalid class" },
        {
          status: 400,
        },
      );
    }

    // Check for overlapping appointments
    const hasOverlap = await checkOverlappingAppointments(
      new Date(slotStartTimeInUTC),
      new Date(slotEndTimeInUTC),
      classDetails.classPlan.consultantProfile.id,
    );

    if (hasOverlap) {
      return NextResponse.json(
        { error: "Time slot overlaps with existing appointment" },
        {
          status: 400,
        },
      );
    }

    // Check class capacity by counting participants from appointments
    const currentParticipants =
      classDetails.appointments?.reduce(
        (count, appointment) => count + appointment.slotsOfAppointment.length,
        0,
      ) ?? 0;

    if (currentParticipants >= (classDetails.classPlan.maxParticipants ?? 1)) {
      return NextResponse.json(
        { error: "Class is at maximum capacity" },
        {
          status: 400,
        },
      );
    }

    // Create appointment with slot
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: AppointmentsType.CLASS,
        class: {
          connect: {
            id: classId,
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
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return NextResponse.json(appointment);
  } catch (error: any) {
    Sentry.captureException(error);
    console.error("Error booking class:", error);
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
