import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { CancellationReason } from "@prisma/client";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { CancelAppointmentSchema } from "@/schemas/appointments";
import {
  logConsultationCancelled,
  logSubscriptionCancelled,
} from "@/lib/activity/log-activity";

import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
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
        webinar: {
          include: {
            webinarPlan: true,
          },
        },
        class: {
          include: {
            classPlan: true,
          },
        },
        slotsOfAppointment: { take: 1, select: { startsAt: true } },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Participant authorization check
    const consultantProfileId = session.user.consultantProfileId;
    const consulteeProfileId = session.user.consulteeProfileId;

    let isParticipant = false;

    if (appointment.consultation) {
      const planConsultantProfileId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.consultation.requestedById;
    } else if (appointment.subscription) {
      const planConsultantProfileId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.subscription.requestedById;
    } else if (appointment.webinar) {
      // Only the consultant (organizer) can cancel a group event
      const webinarConsultantId =
        appointment.webinar.webinarPlan?.consultantProfileId;
      isParticipant = consultantProfileId === webinarConsultantId;
    } else if (appointment.class) {
      // Only the consultant (organizer) can cancel a group event
      const classConsultantId =
        appointment.class.classPlan?.consultantProfileId;
      isParticipant = consultantProfileId === classConsultantId;
    }

    const isPrivilegedUser = isPrivileged(session.user.role);

    if (!isParticipant && !isPrivilegedUser) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
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

        // Soft-cancel: mark slots as CANCELLED instead of deleting.
        // CRITICAL: Do NOT delete appointments — Payment records have onDelete: Cascade
        // and deleting appointments would permanently destroy payment/refund/dispute audit trail.
        if (appointment.subscription) {
          await tx.slotOfAppointment.updateMany({
            where: {
              appointment: { subscriptionId: appointment.subscription.id },
            },
            data: { completionStatus: "CANCELLED" },
          });
        } else if (appointment.class) {
          await tx.slotOfAppointment.updateMany({
            where: { appointment: { classId: appointment.class.id } },
            data: { completionStatus: "CANCELLED" },
          });
        } else {
          // Consultation/webinar/trial — single appointment
          await tx.slotOfAppointment.updateMany({
            where: { appointmentId },
            data: { completionStatus: "CANCELLED" },
          });
        }

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

    // Log cancellation activity for consultant dashboard (awaited — DB write
    // that should not be dropped in serverless; logActivity swallows errors)
    const actor = {
      id: session.user.id,
      name: session.user.name || "User",
      image: session.user.image,
    };
    const cancelledBy =
      session.user.id === notificationMeta.consultantUserId
        ? ("consultant" as const)
        : ("consultee" as const);

    if (appointment.consultation) {
      const cpId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      if (cpId) {
        await logConsultationCancelled(
          cpId,
          appointment.consultation.id,
          actor,
          planTitle || "Consultation",
          cancelledBy,
        );
      }
    } else if (appointment.subscription) {
      const cpId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      if (cpId) {
        await logSubscriptionCancelled(
          cpId,
          appointment.subscription.id,
          actor,
          planTitle || "Subscription",
          cancelledBy,
        );
      }
    }

    // Note: This route cancels the entire event (sets parent to CANCELLED),
    // so we do NOT notify waitlisted users — there is no "spot" to offer.
    // Waitlist notifications should only fire when a participant leaves an
    // otherwise-active event (handled in participant removal flow).

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
