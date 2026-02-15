"use server";

/**
 * Appointment Freeze — called when entering OFFLINE maintenance phase.
 *
 * Finds upcoming appointments within the maintenance window,
 * cancels them with a system-initiated reason, and notifies affected users.
 */

import { notifyAppointmentCancelled } from "@/lib/novu/service";
import prisma from "@/lib/prisma";

export async function freezeAppointments(
  maintenanceStart: Date,
  maintenanceEnd: Date | null,
) {
  // Default to 4 hours if no end time provided
  const windowEnd =
    maintenanceEnd ?? new Date(maintenanceStart.getTime() + 4 * 60 * 60 * 1000);

  // Find all slots that overlap with the maintenance window
  const affectedSlots = await prisma.slotOfAppointment.findMany({
    where: {
      startsAt: { lte: windowEnd },
      endsAt: { gte: maintenanceStart },
      isTentative: false,
    },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
        },
      },
      user: { select: { id: true } },
    },
  });

  if (affectedSlots.length === 0) {
    return { cancelled: 0, notified: 0 };
  }

  let cancelled = 0;
  let notified = 0;

  for (const slot of affectedSlots) {
    const appointment = slot.appointment;

    // Cancel consultation if applicable
    if (appointment.consultation) {
      const consultation = appointment.consultation;
      await prisma.consultation.update({
        where: { id: consultation.id },
        data: {
          requestStatus: "CANCELLED",
          cancellationReason: "TECHNICAL_ISSUE",
          cancellationNotes: "Cancelled due to scheduled platform maintenance",
          cancelledAt: new Date(),
        },
      });

      const consultantUser = consultation.consultationPlan?.consultantProfile?.user;
      const consulteeUser = consultation.requestedBy?.user;
      const userIds: string[] = [];
      if (consulteeUser?.id) userIds.push(consulteeUser.id);
      if (consultantUser?.id) userIds.push(consultantUser.id);

      if (userIds.length > 0) {
        await notifyAppointmentCancelled(userIds, {
          appointmentId: appointment.id,
          appointmentType: "CONSULTATION",
          consultantName: consultantUser?.name || "Consultant",
          consulteeName: consulteeUser?.name || "User",
          planTitle: consultation.consultationPlan?.title || "Consultation",
          dateTime: slot.startsAt.toISOString(),
          dashboardUrl: "/dashboard",
          reason: "Scheduled platform maintenance",
          cancelledBy: "system",
        });
        notified += userIds.length;
      }
    }

    // Cancel subscription appointment if applicable
    if (appointment.subscription) {
      const subscription = appointment.subscription;
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          requestStatus: "CANCELLED",
          cancellationReason: "TECHNICAL_ISSUE",
          cancellationNotes: "Cancelled due to scheduled platform maintenance",
          cancelledAt: new Date(),
        },
      });

      const consultantUser = subscription.subscriptionPlan?.consultantProfile?.user;
      const consulteeUser = subscription.requestedBy?.user;
      const userIds: string[] = [];
      if (consulteeUser?.id) userIds.push(consulteeUser.id);
      if (consultantUser?.id) userIds.push(consultantUser.id);

      if (userIds.length > 0) {
        await notifyAppointmentCancelled(userIds, {
          appointmentId: appointment.id,
          appointmentType: "SUBSCRIPTION",
          consultantName: consultantUser?.name || "Consultant",
          consulteeName: consulteeUser?.name || "User",
          planTitle: subscription.subscriptionPlan?.title || "Subscription",
          dateTime: slot.startsAt.toISOString(),
          dashboardUrl: "/dashboard",
          reason: "Scheduled platform maintenance",
          cancelledBy: "system",
        });
        notified += userIds.length;
      }
    }

    // Delete the slot and appointment
    await prisma.slotOfAppointment.delete({ where: { id: slot.id } });

    // Only delete appointment if no other slots remain
    const remainingSlots = await prisma.slotOfAppointment.count({
      where: { appointmentId: appointment.id },
    });
    if (remainingSlots === 0) {
      await prisma.appointment.delete({ where: { id: appointment.id } });
    }

    cancelled++;
  }

  console.log(
    JSON.stringify({
      event: "maintenance_appointments_frozen",
      cancelled,
      notified,
      windowStart: maintenanceStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timestamp: new Date().toISOString(),
    }),
  );

  return { cancelled, notified };
}
