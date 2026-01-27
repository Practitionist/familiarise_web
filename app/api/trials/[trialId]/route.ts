import prisma from "@/lib/prisma";
import { TrialSessionStatus, AppointmentsType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { logTrialCompleted, logTrialConverted } from "@/lib/activity/log-activity";

interface RouteContext {
  params: Promise<{ trialId: string }>;
}

/**
 * GET /api/trials/[trialId]
 * Get a specific trial session
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { trialId } = await context.params;

  try {
    const trialSession = await prisma.trialSession.findUnique({
      where: { id: trialId },
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
            slotsOfAppointment: {
              include: {
                meetingSession: true,
              },
            },
          },
        },
        convertedToSubscription: true,
      },
    });

    if (!trialSession) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: trialSession });
  } catch (error) {
    console.error("Error fetching trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial session" },
      { status: 500 }
    );
  }
}

interface UpdateTrialRequest {
  status?: TrialSessionStatus;
  scheduledTime?: string; // ISO date string for scheduling
  notes?: string;
}

/**
 * PATCH /api/trials/[trialId]
 * Update a trial session (approve, reject, schedule, complete, etc.)
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { trialId } = await context.params;

  try {
    const body = (await request.json()) as UpdateTrialRequest;
    const { status, scheduledTime, notes } = body;

    // Fetch the existing trial session
    const existingTrial = await prisma.trialSession.findUnique({
      where: { id: trialId },
      include: {
        consulteeProfile: {
          include: {
            user: true,
          },
        },
        consultantProfile: {
          include: {
            user: true,
          },
        },
        subscriptionPlan: true,
        appointment: true,
      },
    });

    if (!existingTrial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 }
      );
    }

    const updateData: Record<string, unknown> = {};

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // Handle status transitions
    if (status) {
      const validTransitions: Record<TrialSessionStatus, TrialSessionStatus[]> = {
        PENDING: ["APPROVED", "CANCELLED", "EXPIRED"],
        APPROVED: ["SCHEDULED", "CANCELLED", "EXPIRED"],
        SCHEDULED: ["COMPLETED", "CANCELLED"],
        COMPLETED: ["CONVERTED"],
        CONVERTED: [],
        CANCELLED: [],
        EXPIRED: [],
      };

      const currentStatus = existingTrial.status;
      if (!validTransitions[currentStatus]?.includes(status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${currentStatus} to ${status}` },
          { status: 400 }
        );
      }

      updateData.status = status;

      // Handle scheduling
      if (status === TrialSessionStatus.SCHEDULED) {
        if (!scheduledTime) {
          return NextResponse.json(
            { error: "scheduledTime is required when scheduling a trial" },
            { status: 400 }
          );
        }

        const startTime = new Date(scheduledTime);
        const durationMinutes = existingTrial.subscriptionPlan.freeTrialDurationMinutes;
        const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

        // Create an appointment for the trial
        const appointment = await prisma.appointment.create({
          data: {
            appointmentType: AppointmentsType.TRIAL,
            slotsOfAppointment: {
              create: {
                startsAt: startTime,
                endsAt: endTime,
                isTentative: false,
                user: {
                  connect: [
                    { id: existingTrial.consulteeProfile.user.id },
                    { id: existingTrial.consultantProfile.user.id },
                  ],
                },
              },
            },
          },
          include: {
            slotsOfAppointment: true,
          },
        });

        updateData.appointmentId = appointment.id;
      }

      // Handle completion
      if (status === TrialSessionStatus.COMPLETED) {
        updateData.completedAt = new Date();

        // Log activity
        await logTrialCompleted(
          existingTrial.consultantProfileId,
          trialId,
          {
            id: existingTrial.consulteeProfile.user.id,
            name: existingTrial.consulteeProfile.user.name,
            image: existingTrial.consulteeProfile.user.image,
          },
          existingTrial.subscriptionPlan.title
        );
      }
    }

    // Update the trial session
    const updatedTrial = await prisma.trialSession.update({
      where: { id: trialId },
      data: updateData,
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
            slotsOfAppointment: {
              include: {
                meetingSession: true,
              },
            },
          },
        },
        convertedToSubscription: true,
      },
    });

    return NextResponse.json({ data: updatedTrial });
  } catch (error) {
    console.error("Error updating trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while updating trial session" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/trials/[trialId]
 * Cancel a trial session
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { trialId } = await context.params;

  try {
    const existingTrial = await prisma.trialSession.findUnique({
      where: { id: trialId },
    });

    if (!existingTrial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 }
      );
    }

    // Only allow cancellation of PENDING, APPROVED, or SCHEDULED trials
    const cancellableStatuses: TrialSessionStatus[] = [
      TrialSessionStatus.PENDING,
      TrialSessionStatus.APPROVED,
      TrialSessionStatus.SCHEDULED,
    ];

    if (!cancellableStatuses.includes(existingTrial.status)) {
      return NextResponse.json(
        { error: `Cannot cancel a trial in ${existingTrial.status} status` },
        { status: 400 }
      );
    }

    // Update status to cancelled
    const updatedTrial = await prisma.trialSession.update({
      where: { id: trialId },
      data: { status: TrialSessionStatus.CANCELLED },
    });

    return NextResponse.json({ data: updatedTrial });
  } catch (error) {
    console.error("Error cancelling trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while cancelling trial session" },
      { status: 500 }
    );
  }
}
