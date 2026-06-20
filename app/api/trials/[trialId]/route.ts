import prisma from "@/lib/prisma";
import { TrialSessionStatus, AppointmentsType, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  logTrialCompleted,
  logTrialScheduled,
  logTrialConverted,
} from "@/lib/activity/log-activity";
import {
  lockTrialSlot,
  unlockTrialSlot,
  ApprovalLock,
} from "@/utils/appointmentlock";
import {
  notifyTrialSessionScheduled,
  notifyTrialSessionCompleted,
  notifyTrialSessionCancelled,
} from "@/lib/novu";
import { UpdateTrialSchema } from "@/schemas/trials";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";

interface RouteContext {
  params: Promise<{ trialId: string }>;
}

/**
 * GET /api/trials/[trialId]
 * Get a specific trial session
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { trialId } = await context.params;

  try {
    const trialSession = await prisma.trialSession.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
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
        { status: 404 },
      );
    }

    return NextResponse.json({ data: trialSession });
  } catch (error) {
    console.error("Error fetching trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial session" },
      { status: 500 },
    );
  }
}

/**
 * Validates that a time slot is still available (no overlapping appointments)
 */
async function validateSlotAvailability(
  consultantProfileId: string,
  startsAt: string,
  endsAt: string,
): Promise<boolean> {
  const startTime = new Date(startsAt);
  const endTime = new Date(endsAt);

  // Use canonical occupancy policy for consistent conflict detection
  const occupiedFilter = buildOccupiedAppointmentFilter(consultantProfileId);

  const overlapping = await prisma.slotOfAppointment.findFirst({
    where: {
      appointment: {
        OR: occupiedFilter,
      },
      // Canonical overlap predicate
      startsAt: { lt: endTime },
      endsAt: { gt: startTime },
    },
  });

  return !overlapping;
}

/**
 * PATCH /api/trials/[trialId]
 * Update a trial session (approve, reject, schedule, complete, etc.)
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { trialId } = await context.params;

  try {
    const body = await request.json();
    const parseResult = UpdateTrialSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parseResult.error.issues },
        { status: 400 },
      );
    }
    const { status, scheduledTime, slotData, notes, subscriptionId } =
      parseResult.data;

    // Fetch the existing trial session
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
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
        { status: 404 },
      );
    }

    const updateData: Prisma.TrialSessionUpdateInput = {};

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // Handle status transitions
    if (status) {
      // Simplified state machine: PENDING → SCHEDULED → COMPLETED → CONVERTED
      // REJECTED = consultant declines, CANCELLED = consultee cancels
      const validTransitions: Record<TrialSessionStatus, TrialSessionStatus[]> =
        {
          PENDING: ["SCHEDULED", "CANCELLED", "REJECTED"],
          SCHEDULED: ["COMPLETED", "CANCELLED"],
          COMPLETED: ["CONVERTED"],
          CONVERTED: [],
          CANCELLED: [],
          REJECTED: [],
        };

      const currentStatus = existingTrial.status;
      if (!validTransitions[currentStatus]?.includes(status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${currentStatus} to ${status}` },
          { status: 400 },
        );
      }

      // Role-based transition guards
      const isTrialConsultant =
        session.user.consultantProfileId === existingTrial.consultantProfileId;
      const isTrialConsultee =
        session.user.consulteeProfileId === existingTrial.consulteeProfileId;
      const isPrivilegedUser = isPrivileged(session.user.role);

      if (!isTrialConsultant && !isTrialConsultee && !isPrivilegedUser) {
        return NextResponse.json(
          { error: "Not a participant of this trial" },
          { status: 403 },
        );
      }

      // Consultee can only cancel their trials
      if (isTrialConsultee && !isTrialConsultant && !isPrivilegedUser) {
        if (status !== TrialSessionStatus.CANCELLED) {
          return NextResponse.json(
            { error: "Consultees can only cancel trial sessions" },
            { status: 403 },
          );
        }
      }

      // CONVERTED requires consultant or privileged
      if (
        status === TrialSessionStatus.CONVERTED &&
        !isTrialConsultant &&
        !isPrivilegedUser
      ) {
        return NextResponse.json(
          { error: "Only the consultant can convert a trial" },
          { status: 403 },
        );
      }

      updateData.status = status;

      // Handle scheduling with distributed locking
      if (status === TrialSessionStatus.SCHEDULED) {
        // Support both new slotData and legacy scheduledTime
        if (!slotData && !scheduledTime) {
          return NextResponse.json(
            {
              error:
                "slotData or scheduledTime is required when scheduling a trial",
            },
            { status: 400 },
          );
        }

        let startTime: Date;
        let endTime: Date;

        if (slotData) {
          startTime = new Date(slotData.startsAt);
          endTime = new Date(slotData.endsAt);
        } else {
          startTime = new Date(scheduledTime!);
          const durationMinutes =
            existingTrial.subscriptionPlan.freeTrialDurationMinutes;
          endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
        }

        // 1. Acquire distributed lock to prevent race conditions
        let lock: ApprovalLock | null = null;
        try {
          lock = await lockTrialSlot(
            existingTrial.consultantProfileId,
            startTime.toISOString(),
          );
        } catch {
          return NextResponse.json(
            {
              error:
                "This time slot is currently being processed. Please try again.",
            },
            { status: 423 }, // Locked
          );
        }

        try {
          // 2. Validate slot availability (within lock)
          const isAvailable = await validateSlotAvailability(
            existingTrial.consultantProfileId,
            startTime.toISOString(),
            endTime.toISOString(),
          );

          if (!isAvailable) {
            return NextResponse.json(
              {
                error:
                  "Selected slot is no longer available. Please choose a different time.",
              },
              { status: 409 },
            );
          }

          // 3. Create appointment + update trial atomically using transaction
          const result = await prisma.$transaction(async (tx) => {
            // Create an appointment for the trial
            const appointment = await tx.appointment.create({
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

            // Update trial with appointment link and scheduled status
            const updatedTrial = await tx.trialSession.update({
              where: { id: trialId },
              data: {
                status: TrialSessionStatus.SCHEDULED,
                appointmentId: appointment.id,
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

            return updatedTrial;
          });

          // 4. Log activity (outside transaction for non-critical operation)
          await logTrialScheduled(
            existingTrial.consultantProfileId,
            trialId,
            {
              id: existingTrial.consulteeProfile.user.id,
              name: existingTrial.consulteeProfile.user.name,
              image: existingTrial.consulteeProfile.user.image,
            },
            existingTrial.subscriptionPlan.title,
            startTime,
          );

          // Notify the consultee that their trial has been scheduled
          void notifyTrialSessionScheduled(
            existingTrial.consulteeProfile.user.id,
            {
              consultantName:
                existingTrial.consultantProfile.user.name || "Consultant",
              consulteeName: existingTrial.consulteeProfile.user.name || "User",
              planTitle: existingTrial.subscriptionPlan.title,
              dateTime: startTime.toISOString(),
              status: TrialSessionStatus.SCHEDULED,
              dashboardUrl: "/dashboard",
            },
          );

          return NextResponse.json({ data: result });
        } finally {
          // 5. Always release lock
          if (lock) {
            await unlockTrialSlot(lock);
          }
        }
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
          existingTrial.subscriptionPlan.title,
        );

        // Notify both parties that the trial is completed
        void notifyTrialSessionCompleted(
          [
            existingTrial.consultantProfile.user.id,
            existingTrial.consulteeProfile.user.id,
          ],
          {
            consultantName:
              existingTrial.consultantProfile.user.name || "Consultant",
            consulteeName: existingTrial.consulteeProfile.user.name || "User",
            planTitle: existingTrial.subscriptionPlan.title,
            status: TrialSessionStatus.COMPLETED,
            dashboardUrl: "/dashboard",
          },
        );
      }

      // Handle cancellation / rejection
      if (
        status === TrialSessionStatus.CANCELLED ||
        status === TrialSessionStatus.REJECTED
      ) {
        void notifyTrialSessionCancelled(
          [
            existingTrial.consultantProfile.user.id,
            existingTrial.consulteeProfile.user.id,
          ],
          {
            consultantName:
              existingTrial.consultantProfile.user.name || "Consultant",
            consulteeName: existingTrial.consulteeProfile.user.name || "User",
            planTitle: existingTrial.subscriptionPlan.title,
            status,
            dashboardUrl: "/dashboard",
          },
        );

        // FIX #579: Clean up linked appointment and slots to free availability.
        // Without this, PATCH cancellation leaves slots occupied while DELETE
        // correctly frees them — same business action, different behavior.
        // Wrapped in a transaction: disconnect trial first (avoids FK violation),
        // then delete appointment (cascade handles slots automatically).
        if (existingTrial.appointmentId) {
          const appointmentIdToDelete = existingTrial.appointmentId;
          await prisma.$transaction(async (tx) => {
            // 1. Disconnect the appointment from the trial first
            await tx.trialSession.update({
              where: { id: trialId },
              data: { appointment: { disconnect: true } },
            });
            // 2. Now safe to delete — cascade handles SlotOfAppointment
            await tx.appointment.delete({
              where: { id: appointmentIdToDelete },
            });
          });
        }
      }

      // Handle trial conversion — requires a linked subscription
      if (status === TrialSessionStatus.CONVERTED) {
        if (!subscriptionId) {
          return NextResponse.json(
            {
              error:
                "subscriptionId is required when converting a trial to a subscription",
            },
            { status: 400 },
          );
        }

        // Validate the subscription exists and belongs to the same plan/consultee
        const subscription = await prisma.subscription.findUnique({
          where: { id: subscriptionId },
          select: {
            id: true,
            subscriptionPlanId: true,
            requestedById: true,
          },
        });

        if (!subscription) {
          return NextResponse.json(
            { error: "Subscription not found" },
            { status: 404 },
          );
        }

        if (
          subscription.subscriptionPlanId !==
          existingTrial.subscriptionPlanId
        ) {
          return NextResponse.json(
            {
              error:
                "Subscription must belong to the same plan as the trial",
            },
            { status: 400 },
          );
        }

        if (subscription.requestedById !== existingTrial.consulteeProfileId) {
          return NextResponse.json(
            {
              error:
                "Subscription must belong to the same consultee as the trial",
            },
            { status: 400 },
          );
        }

        // Link the subscription to the trial
        updateData.convertedToSubscription = {
          connect: { id: subscriptionId },
        };

        // Log the conversion activity
        void logTrialConverted(
          existingTrial.consultantProfileId,
          trialId,
          subscriptionId,
          {
            id: existingTrial.consulteeProfile.user.id,
            name: existingTrial.consulteeProfile.user.name || "User",
            image: existingTrial.consulteeProfile.user.image,
          },
          existingTrial.subscriptionPlan.title,
        );
      }
    }

    // Update the trial session (status + any other fields)
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
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/trials/[trialId]
 * Cancel a trial session
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { trialId } = await context.params;

  try {
    const existingTrial = await prisma.trialSession.findUnique({
      where: {
        id: trialId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              OR: [
                {
                  consulteeProfileId:
                    session.user.consulteeProfileId ?? "__none__",
                },
                {
                  consultantProfileId:
                    session.user.consultantProfileId ?? "__none__",
                },
              ],
            }),
      },
      include: {
        consultantProfile: {
          include: { user: { select: { id: true, name: true } } },
        },
        consulteeProfile: {
          include: { user: { select: { id: true, name: true } } },
        },
        subscriptionPlan: { select: { title: true } },
      },
    });

    if (!existingTrial) {
      return NextResponse.json(
        { error: "Trial session not found" },
        { status: 404 },
      );
    }

    // Only allow cancellation of PENDING or SCHEDULED trials
    const cancellableStatuses: TrialSessionStatus[] = [
      TrialSessionStatus.PENDING,
      TrialSessionStatus.SCHEDULED,
    ];

    if (!cancellableStatuses.includes(existingTrial.status)) {
      return NextResponse.json(
        { error: `Cannot cancel a trial in ${existingTrial.status} status` },
        { status: 400 },
      );
    }

    // Atomic: cancel trial + clean up appointment in one transaction.
    // Disconnect appointment first to avoid FK violation, then delete
    // (cascade handles SlotOfAppointment automatically).
    const updatedTrial = await prisma.$transaction(async (tx) => {
      const trial = await tx.trialSession.update({
        where: { id: trialId },
        data: {
          status: TrialSessionStatus.CANCELLED,
          ...(existingTrial.appointmentId
            ? { appointment: { disconnect: true } }
            : {}),
        },
      });

      if (existingTrial.appointmentId) {
        await tx.appointment.delete({
          where: { id: existingTrial.appointmentId },
        });
      }

      return trial;
    });

    // FIX #554: Send cancellation notification (DELETE path was missing this)
    void notifyTrialSessionCancelled(
      [
        existingTrial.consultantProfile.user.id,
        existingTrial.consulteeProfile.user.id,
      ],
      {
        consultantName:
          existingTrial.consultantProfile.user.name || "Consultant",
        consulteeName: existingTrial.consulteeProfile.user.name || "User",
        planTitle: existingTrial.subscriptionPlan.title,
        status: TrialSessionStatus.CANCELLED,
        dashboardUrl: "/dashboard",
      },
    );

    return NextResponse.json({ data: updatedTrial });
  } catch (error) {
    console.error("Error cancelling trial session:", error);
    return NextResponse.json(
      { error: "An error occurred while cancelling trial session" },
      { status: 500 },
    );
  }
}
