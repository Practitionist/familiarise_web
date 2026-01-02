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
 * Reschedule an appointment or specific session(s) within a subscription.
 *
 * Query Parameters:
 * - type: AppointmentType (CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS)
 *
 * Body (optional):
 * - slotIds: string[] - For SUBSCRIPTION type only. If provided, only these specific
 *                       slots will be marked as tentative. If not provided,
 *                       all slots in the subscription will be marked as tentative.
 *
 * Behavior:
 * - For CONSULTATION: Marks all slots as tentative, reverts status to PENDING
 * - For SUBSCRIPTION with slotIds: Marks only specified slots as tentative (individual/multiple session reschedule)
 * - For SUBSCRIPTION without slotIds: Marks ALL slots as tentative (entire subscription reschedule)
 * - For WEBINAR/CLASS: Marks all slots as tentative
 *
 * 24-Hour Restriction:
 * - Cannot reschedule if ANY slot to be rescheduled is within 24 hours
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

    // Parse request body for optional slotIds (used for individual/multiple session reschedule)
    let slotIds: string[] | undefined;
    try {
      const body = await request.json();
      // Support both single slotId (legacy) and slotIds array
      if (body?.slotIds && Array.isArray(body.slotIds)) {
        slotIds = body.slotIds;
      } else if (body?.slotId) {
        // Legacy support: convert single slotId to array
        slotIds = [body.slotId];
      }
    } catch {
      // No body or invalid JSON - that's fine, slotIds is optional
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

        // For SUBSCRIPTION with slotIds, only reschedule the specific slots
        if (
          appointmentType === "SUBSCRIPTION" &&
          slotIds &&
          slotIds.length > 0 &&
          appointment.subscription
        ) {
          // Filter to only the requested slots
          slotsToReschedule = appointment.slotsOfAppointment.filter((s) =>
            slotIds.includes(s.id),
          );

          // Validate all requested slots exist
          if (slotsToReschedule.length !== slotIds.length) {
            const foundIds = slotsToReschedule.map((s) => s.id);
            const missingIds = slotIds.filter((id) => !foundIds.includes(id));
            throw new AppointmentNotFoundError("slot", missingIds.join(", "));
          }
        }

        // 24-hour restriction check - validate ALL selected slots
        const now = new Date();
        for (const slot of slotsToReschedule) {
          const hoursUntilSlot =
            (new Date(slot.startsAt).getTime() - now.getTime()) /
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
          slotIds &&
          slotIds.length > 0 &&
          appointment.subscription
        ) {
          // Individual/multiple session reschedule - only mark the specific slots
          await tx.slotOfAppointment.updateMany({
            where: {
              id: { in: slotIds },
              appointmentId, // Security: ensure slots belong to this appointment
            },
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

        // Determine reschedule type for response
        const getRescheduleType = () => {
          if (appointmentType !== "SUBSCRIPTION" || !slotIds || slotIds.length === 0) {
            return "entire_booking";
          }
          if (slotIds.length === 1) {
            return "individual_session";
          }
          return "multiple_sessions";
        };

        const rescheduleType = getRescheduleType();

        // Return detailed response
        return {
          success: true,
          rescheduleType,
          slotsAffected: slotsToReschedule.length,
          message:
            rescheduleType === "entire_booking"
              ? "All sessions marked for rescheduling. Please select new times."
              : `${slotsToReschedule.length} session(s) marked for rescheduling. Please select new time(s).`,
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
