import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { CancellationReason } from "@prisma/client";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { CancelAppointmentSchema } from "@/schemas/appointments";

import { getSession } from "@/lib/auth-server";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
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

    // Fetch appointment BEFORE transaction to avoid timeout on heavy queries
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        webinar: true,
        class: true,
        slotsOfAppointment: { take: 1, select: { startsAt: true } },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Extract notification data BEFORE transaction (appointment will be deleted)
    let consultantUserId: string | undefined;
    let consulteeUserId: string | undefined;
    let consultantName: string | undefined;
    let consulteeName: string | undefined;
    let planTitle: string | undefined;
    const appointmentType: string = appointment.appointmentType;
    const dateTime =
      appointment.slotsOfAppointment?.[0]?.startsAt?.toISOString();

    if (appointment.consultation) {
      consultantUserId =
        appointment.consultation.consultationPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.consultation.requestedBy?.user?.id;
      consultantName =
        appointment.consultation.consultationPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.consultation.requestedBy?.user?.name || undefined;
      planTitle = appointment.consultation.consultationPlan?.title;
    } else if (appointment.subscription) {
      consultantUserId =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.subscription.requestedBy?.user?.id;
      consultantName =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.subscription.requestedBy?.user?.name || undefined;
      planTitle = appointment.subscription.subscriptionPlan?.title;
    }

    // Prepare cancellation data
    const cancellationData = {
      requestStatus: "CANCELLED" as const,
      cancellationReason: (validatedData.reason as CancellationReason) || null,
      cancellationNotes: validatedData.notes || null,
      cancelledAt: new Date(),
      cancelledBy: session.user.id,
    };

    // Transaction for critical database operations only (with increased timeout)
    const result = await prisma.$transaction(
      async (tx) => {
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

        return {
          success: true,
          cancellationReason: validatedData.reason,
          cancelledAt: cancellationData.cancelledAt,
          webinarId: appointment.webinar?.id,
          classId: appointment.class?.id,
        };
      },
      {
        maxWait: 10000, // Max time to wait for connection
        timeout: 30000, // 30 second transaction timeout (was 5s default)
      },
    );

    // Notification metadata (for fire-and-forget notifications after transaction)
    const notificationMeta = {
      consultantUserId,
      consulteeUserId,
      consultantName,
      consulteeName,
      planTitle,
      appointmentType,
      dateTime,
      cancelledBy: session.user.id,
    };

    // Fire-and-forget: notify both parties about cancellation
    const userIds = [
      notificationMeta.consultantUserId,
      notificationMeta.consulteeUserId,
    ].filter((id): id is string => !!id);
    if (userIds.length > 0) {
      void notifyAppointmentCancelled(userIds, {
        appointmentType: notificationMeta.appointmentType,
        consultantName: notificationMeta.consultantName || "Consultant",
        consulteeName: notificationMeta.consulteeName || "Consultee",
        planTitle: notificationMeta.planTitle || "N/A",
        dateTime: notificationMeta.dateTime,
        dashboardUrl: "/dashboard",
        reason: validatedData.reason || undefined,
        cancelledBy:
          notificationMeta.cancelledBy === notificationMeta.consultantUserId
            ? "consultant"
            : "consultee",
      });
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

    return NextResponse.json(result);
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
