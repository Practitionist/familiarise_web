import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import {
  ReschedulePolicyError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";

const MINIMUM_HOURS_BEFORE_RESCHEDULE = 24;

/**
 * POST /api/appointments/[appointmentId]/reschedule
 *
 * Reschedule an appointment or specific session within a subscription.
 *
 * Query Parameters:
 * - type: AppointmentType (CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS)
 *
 * Body (optional):
 * - slotId: string - For SUBSCRIPTION type only. If provided, only this specific
 *                    session/slot will be marked as tentative. If not provided,
 *                    all slots in the subscription will be marked as tentative.
 *
 * Behavior:
 * - For CONSULTATION: Marks all slots as tentative, reverts status to PENDING
 * - For SUBSCRIPTION with slotId: Marks only the specified slot as tentative (individual session reschedule)
 * - For SUBSCRIPTION without slotId: Marks ALL slots as tentative (entire subscription reschedule)
 * - For WEBINAR/CLASS: Marks all slots as tentative
 *
 * 24-Hour Restriction:
 * - Cannot reschedule if the earliest slot to be rescheduled is within 24 hours
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;
    const { searchParams } = new URL(request.url);
    const appointmentType = searchParams.get("type");

    // Parse request body for optional slotId (used for individual session reschedule)
    let slotId: string | undefined;
    try {
      const body = await request.json();
      slotId = body?.slotId;
    } catch {
      // No body or invalid JSON - that's fine, slotId is optional
    }

    // Start transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Get appointment details with all related data
        const appointment = await tx.appointment.findUnique({
          where: { id: appointmentId },
          include: {
            slotsOfAppointment: {
              orderBy: { startsAt: "asc" },
            },
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: true,
                  },
                },
                requestedBy: true,
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: true,
                  },
                },
                requestedBy: true,
              },
            },
            webinar: true,
            class: true,
          },
        });

        if (!appointment) {
          throw new AppointmentNotFoundError("appointment", appointmentId);
        }

        // Determine which slots will be affected
        let slotsToReschedule = appointment.slotsOfAppointment;

        // For SUBSCRIPTION with slotId, only reschedule the specific slot
        if (
          appointmentType === "SUBSCRIPTION" &&
          slotId &&
          appointment.subscription
        ) {
          const targetSlot = appointment.slotsOfAppointment.find(
            (s) => s.id === slotId,
          );
          if (!targetSlot) {
            throw new AppointmentNotFoundError("slot", slotId);
          }
          slotsToReschedule = [targetSlot];
        }

        // 24-hour restriction check
        const now = new Date();
        const earliestSlot = slotsToReschedule[0];
        if (earliestSlot) {
          const hoursUntilSlot =
            (new Date(earliestSlot.startsAt).getTime() - now.getTime()) /
            (1000 * 60 * 60);

          if (hoursUntilSlot < MINIMUM_HOURS_BEFORE_RESCHEDULE) {
            throw new ReschedulePolicyError(
              hoursUntilSlot,
              MINIMUM_HOURS_BEFORE_RESCHEDULE,
            );
          }
        }

        // Mark the appropriate slots as tentative
        if (
          appointmentType === "SUBSCRIPTION" &&
          slotId &&
          appointment.subscription
        ) {
          // Individual session reschedule - only mark the specific slot
          await tx.slotOfAppointment.update({
            where: { id: slotId },
            data: { isTentative: true },
          });
        } else {
          // Entire appointment/subscription reschedule - mark all slots
          await tx.slotOfAppointment.updateMany({
            where: { appointmentId },
            data: { isTentative: true },
          });
        }

        // Update status based on appointment type
        if (appointment.consultation) {
          await tx.consultation.update({
            where: { id: appointment.consultation.id },
            data: { requestStatus: "PENDING" },
          });
        } else if (appointment.subscription) {
          await tx.subscription.update({
            where: { id: appointment.subscription.id },
            data: { requestStatus: "PENDING" },
          });
        } else if (appointment.webinar) {
          await tx.webinar.update({
            where: { id: appointment.webinar.id },
            data: { status: "SCHEDULED" },
          });
        } else if (appointment.class) {
          await tx.class.update({
            where: { id: appointment.class.id },
            data: { status: "SCHEDULED" },
          });
        }

        // Return detailed response
        return {
          success: true,
          rescheduleType:
            appointmentType === "SUBSCRIPTION" && slotId
              ? "individual_session"
              : "entire_booking",
          slotsAffected: slotsToReschedule.length,
          message:
            appointmentType === "SUBSCRIPTION" && slotId
              ? "Session marked for rescheduling. Please select a new time."
              : "All sessions marked for rescheduling. Please select new times.",
        };
      },
      {
        timeout: 60000, // 60 second timeout for complex transactions
      },
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error requesting reschedule:", error);

    // Type-safe error handling using custom error classes
    if (error instanceof ReschedulePolicyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof AppointmentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to request reschedule" },
      { status: 500 },
    );
  }
}
