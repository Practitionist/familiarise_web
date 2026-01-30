import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { CancellationReason } from "@prisma/client";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { CancelAppointmentSchema } from "@/schemas/appointments";

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

    // Parse optional request body for cancellation reason
    let validatedData: { reason?: string; notes?: string } = {};
    try {
      const text = await request.text();
      if (text) {
        const parsed = JSON.parse(text);
        const result = CancelAppointmentSchema.safeParse(parsed);
        if (!result.success) {
          return NextResponse.json(
            { error: "Validation failed", details: result.error.issues },
            { status: 400 },
          );
        }
        validatedData = result.data;
      }
    } catch {
      // Body parsing is optional - continue without it
    }

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // Get appointment details (include user data for notifications)
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: {
                  consultantProfile: { include: { user: { select: { id: true, name: true } } } },
                },
              },
              requestedBy: { include: { user: { select: { id: true, name: true } } } },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: {
                  consultantProfile: { include: { user: { select: { id: true, name: true } } } },
                },
              },
              requestedBy: { include: { user: { select: { id: true, name: true } } } },
            },
          },
          webinar: true,
          class: true,
          slotsOfAppointment: { take: 1, select: { startsAt: true } },
        },
      });

      if (!appointment) {
        throw new Error("Appointment not found");
      }

      // Prepare cancellation data
      const cancellationData = {
        requestStatus: "CANCELLED" as const,
        cancellationReason: (validatedData.reason as CancellationReason) || null,
        cancellationNotes: validatedData.notes || null,
        cancelledAt: new Date(),
        cancelledBy: session.user.id,
      };

      // Update appointment status based on type
      if (appointment.consultation) {
        await tx.consultation.update({
          where: { id: appointment.consultation.id },
          data: cancellationData,
        });
      } else if (appointment.subscription) {
        await tx.subscription.update({
          where: { id: appointment.subscription.id },
          data: cancellationData,
        });
      } else if (appointment.webinar) {
        await tx.webinar.update({
          where: { id: appointment.webinar.id },
          data: { status: "CANCELLED" },
        });
      } else if (appointment.class) {
        await tx.class.update({
          where: { id: appointment.class.id },
          data: { status: "CANCELLED" },
        });
      }

      // Delete slots
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId },
      });

      // Delete appointment
      await tx.appointment.delete({
        where: { id: appointmentId },
      });

      // Extract notification data before returning (appointment is deleted after this)
      let consultantUserId: string | undefined;
      let consulteeUserId: string | undefined;
      let consultantName: string | undefined;
      let consulteeName: string | undefined;
      let planTitle: string | undefined;
      let appointmentType: string = appointment.appointmentType;
      const dateTime = appointment.slotsOfAppointment?.[0]?.startsAt?.toISOString();

      if (appointment.consultation) {
        consultantUserId = appointment.consultation.consultationPlan?.consultantProfile?.user?.id;
        consulteeUserId = appointment.consultation.requestedBy?.user?.id;
        consultantName = appointment.consultation.consultationPlan?.consultantProfile?.user?.name || undefined;
        consulteeName = appointment.consultation.requestedBy?.user?.name || undefined;
        planTitle = appointment.consultation.consultationPlan?.title;
      } else if (appointment.subscription) {
        consultantUserId = appointment.subscription.subscriptionPlan?.consultantProfile?.user?.id;
        consulteeUserId = appointment.subscription.requestedBy?.user?.id;
        consultantName = appointment.subscription.subscriptionPlan?.consultantProfile?.user?.name || undefined;
        consulteeName = appointment.subscription.requestedBy?.user?.name || undefined;
        planTitle = appointment.subscription.subscriptionPlan?.title;
      }

      return {
        success: true,
        cancellationReason: validatedData.reason,
        cancelledAt: cancellationData.cancelledAt,
        webinarId: appointment.webinar?.id,
        classId: appointment.class?.id,
        // Notification metadata (not sent to client)
        _notificationMeta: {
          consultantUserId,
          consulteeUserId,
          consultantName,
          consulteeName,
          planTitle,
          appointmentType,
          dateTime,
          cancelledBy: session.user.id,
        },
      };
    });

    // Fire-and-forget: notify both parties about cancellation
    const meta = result._notificationMeta;
    if (meta) {
      const userIds = [meta.consultantUserId, meta.consulteeUserId].filter(
        (id): id is string => !!id,
      );
      if (userIds.length > 0) {
        void notifyAppointmentCancelled(userIds, {
          appointmentType: meta.appointmentType,
          consultantName: meta.consultantName || "Consultant",
          consulteeName: meta.consulteeName || "Consultee",
          planTitle: meta.planTitle || "N/A",
          dateTime: meta.dateTime,
          dashboardUrl: "/dashboard",
          reason: validatedData.reason || undefined,
          cancelledBy:
            meta.cancelledBy === meta.consultantUserId
              ? "consultant"
              : "consultee",
        });
      }
    }

    // Notify waitlist if a webinar or class appointment was cancelled
    if (result.webinarId || result.classId) {
      try {
        await handleSlotOpening({
          webinarId: result.webinarId ?? undefined,
          classId: result.classId ?? undefined,
          slotsAvailable: 1,
          reason: "cancellation",
        });

        console.log(
          JSON.stringify({
            event: "waitlist_notified_after_cancellation",
            webinarId: result.webinarId,
            classId: result.classId,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (waitlistError) {
        // Log but don't fail the cancellation - waitlist notification is best-effort
        console.error(
          "Failed to notify waitlist after cancellation:",
          waitlistError,
        );
      }
    }

    // Strip internal notification metadata before sending response
    const { _notificationMeta: _, ...clientResult } = result;
    return NextResponse.json(clientResult);
  } catch (error) {
    console.error("Error canceling appointment:", error);

    if (error instanceof Error && error.message === "Appointment not found") {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}
