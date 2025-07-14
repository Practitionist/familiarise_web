import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { RequestStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const {
      consultantProfileId,
      slotStartTimeInUTC,
      slotEndTimeInUTC,
      slotOfAvailabilityWeeklyId,
      slotOfAvailabilityCustomId,
      consultationPlanId,
    } = body;

    // Validate required fields
    if (
      !consultantProfileId ||
      !slotStartTimeInUTC ||
      !slotEndTimeInUTC ||
      !consultationPlanId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate that only one slot availability ID is provided
    if (slotOfAvailabilityWeeklyId && slotOfAvailabilityCustomId) {
      return NextResponse.json(
        {
          error: "Cannot provide both weekly and custom slot availability IDs",
        },
        { status: 400 }
      );
    }

    if (!slotOfAvailabilityWeeklyId && !slotOfAvailabilityCustomId) {
      return NextResponse.json(
        { error: "Must provide either weekly or custom slot availability ID" },
        { status: 400 }
      );
    }

    // Validate dates
    const startTime = new Date(slotStartTimeInUTC);
    const endTime = new Date(slotEndTimeInUTC);

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 }
      );
    }

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 }
      );
    }

    // Get the consultee profile
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
      include: { user: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 }
      );
    }

    // Verify the consultation plan exists and belongs to the consultant
    const consultationPlan = await prisma.consultationPlan.findFirst({
      where: {
        id: consultationPlanId,
        consultantProfileId: consultantProfileId,
      },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!consultationPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 }
      );
    }

    // Create request notes with availability slot information
    const requestNotes =
      `Request for approval - Slot: ${startTime.toISOString()} to ${endTime.toISOString()}. ` +
      `Availability slot: ${slotOfAvailabilityWeeklyId ? `Weekly ID: ${slotOfAvailabilityWeeklyId}` : `Custom ID: ${slotOfAvailabilityCustomId}`}`;

    // Create the consultation with pending status
    const consultation = await prisma.consultation.create({
      data: {
        consultationPlanId: consultationPlanId,
        requestedById: consulteeProfile.id,
        requestStatus: RequestStatus.PENDING,
        requestNotes: requestNotes,
        appointment: {
          create: {
            appointmentType: "CONSULTATION",
            slotsOfAppointment: {
              create: {
                slotStartTimeInUTC: startTime,
                slotEndTimeInUTC: endTime,
                isTentative: true, // Mark as tentative since it's pending approval
                type: slotOfAvailabilityWeeklyId ? "WEEKLY" : "CUSTOM", // Set type based on availability source
                user: {
                  connect: [
                    { id: session.user.id }, // Consultee
                    { id: consultationPlan.consultantProfile.user.id }, // Consultant
                  ],
                },
              },
            },
          },
        },
      },
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
        appointment: {
          include: {
            slotsOfAppointment: true,
          },
        },
      },
    });

    return NextResponse.json(
      {
        message: "Request for approval submitted successfully",
        data: consultation,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating approval request:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the approval request" },
      { status: 500 }
    );
  }
}
