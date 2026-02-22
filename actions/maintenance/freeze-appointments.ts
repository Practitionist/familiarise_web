"use server";

/**
 * Appointment Freeze — called when entering OFFLINE maintenance phase.
 *
 * Finds upcoming appointments within the maintenance window,
 * cancels them with a system-initiated reason, and notifies affected users.
 */

import crypto from "crypto";

import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { createRefund } from "@/lib/payments";
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
          payment: {
            where: { paymentStatus: "SUCCEEDED" },
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentIntent: true,
              paymentGateway: true,
            },
          },
        },
      },
      user: { select: { id: true } },
    },
  });

  if (affectedSlots.length === 0) {
    return { cancelled: 0, notified: 0, refundsIssued: 0, refundErrors: 0 };
  }

  // Group slots by appointment to avoid duplicate cancellations and N+1 queries
  type AffectedSlot = (typeof affectedSlots)[number];
  const slotsByAppointment: Record<string, AffectedSlot[]> = {};
  for (const slot of affectedSlots) {
    const id = slot.appointment.id;
    if (slotsByAppointment[id]) {
      slotsByAppointment[id].push(slot);
    } else {
      slotsByAppointment[id] = [slot];
    }
  }

  let cancelled = 0;
  let notified = 0;
  let refundsIssued = 0;
  let refundErrors = 0;

  // Collect payment data to refund AFTER the transaction commits.
  // Payments linked to appointments that have SUCCEEDED payments are kept alive
  // (appointment not deleted) so refund records can reference them.
  type PendingRefundPayment = AffectedSlot["appointment"]["payment"][number];
  const pendingRefunds: PendingRefundPayment[] = [];

  // Collect notification payloads to send AFTER the transaction commits.
  // External API calls (Novu) cannot be rolled back, so they must run
  // outside the transaction to avoid notifying users about cancellations
  // that were later rolled back.
  type NotificationPayload = {
    userIds: string[];
    data: Parameters<typeof notifyAppointmentCancelled>[1];
  };
  const pendingNotifications: NotificationPayload[] = [];

  // Wrap all DB writes in a single transaction for atomicity.
  // If any appointment cancel fails mid-loop, all prior cancellations
  // in this batch are rolled back — preventing partial freeze state.
  await prisma.$transaction(
    async (tx) => {
      for (const appointmentId of Object.keys(slotsByAppointment)) {
        const slots = slotsByAppointment[appointmentId];
        const appointment = slots[0].appointment;
        const earliestSlot = slots.reduce(
          (a: AffectedSlot, b: AffectedSlot) =>
            a.startsAt < b.startsAt ? a : b,
        );

        // Cancel consultation if applicable
        if (appointment.consultation) {
          const consultation = appointment.consultation;
          await tx.consultation.update({
            where: { id: consultation.id },
            data: {
              requestStatus: "CANCELLED",
              cancellationReason: "TECHNICAL_ISSUE",
              cancellationNotes:
                "Cancelled due to scheduled platform maintenance",
              cancelledAt: new Date(),
            },
          });

          const consultantUser =
            consultation.consultationPlan?.consultantProfile?.user;
          const consulteeUser = consultation.requestedBy?.user;
          const userIds: string[] = [];
          if (consulteeUser?.id) userIds.push(consulteeUser.id);
          if (consultantUser?.id) userIds.push(consultantUser.id);

          if (userIds.length > 0) {
            pendingNotifications.push({
              userIds,
              data: {
                appointmentId: appointment.id,
                appointmentType: "CONSULTATION",
                consultantName: consultantUser?.name || "Consultant",
                consulteeName: consulteeUser?.name || "User",
                planTitle:
                  consultation.consultationPlan?.title || "Consultation",
                dateTime: earliestSlot.startsAt.toISOString(),
                dashboardUrl: "/dashboard",
                reason: "Scheduled platform maintenance",
                cancelledBy: "system",
              },
            });
          }
        }

        // Cancel subscription appointment if applicable
        if (appointment.subscription) {
          const subscription = appointment.subscription;
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              requestStatus: "CANCELLED",
              cancellationReason: "TECHNICAL_ISSUE",
              cancellationNotes:
                "Cancelled due to scheduled platform maintenance",
              cancelledAt: new Date(),
            },
          });

          const consultantUser =
            subscription.subscriptionPlan?.consultantProfile?.user;
          const consulteeUser = subscription.requestedBy?.user;
          const userIds: string[] = [];
          if (consulteeUser?.id) userIds.push(consulteeUser.id);
          if (consultantUser?.id) userIds.push(consultantUser.id);

          if (userIds.length > 0) {
            pendingNotifications.push({
              userIds,
              data: {
                appointmentId: appointment.id,
                appointmentType: "SUBSCRIPTION",
                consultantName: consultantUser?.name || "Consultant",
                consulteeName: consulteeUser?.name || "User",
                planTitle:
                  subscription.subscriptionPlan?.title || "Subscription",
                dateTime: earliestSlot.startsAt.toISOString(),
                dashboardUrl: "/dashboard",
                reason: "Scheduled platform maintenance",
                cancelledBy: "system",
              },
            });
          }
        }

        // Cancel webinar if applicable
        if (appointment.webinar) {
          const webinar = appointment.webinar;
          await tx.webinar.update({
            where: { id: webinar.id },
            data: { status: "CANCELLED" },
          });

          const consultantUser = webinar.webinarPlan?.consultantProfile?.user;
          const participantIds = slots.flatMap((s: AffectedSlot) =>
            s.user.map((u) => u.id),
          );
          const userIds = Array.from(new Set(participantIds));
          if (consultantUser?.id && !userIds.includes(consultantUser.id)) {
            userIds.push(consultantUser.id);
          }

          if (userIds.length > 0) {
            pendingNotifications.push({
              userIds,
              data: {
                appointmentId: appointment.id,
                appointmentType: "WEBINAR",
                consultantName: consultantUser?.name || "Consultant",
                consulteeName: "Participants",
                planTitle: webinar.webinarPlan?.title || "Webinar",
                dateTime: earliestSlot.startsAt.toISOString(),
                dashboardUrl: "/dashboard",
                reason: "Scheduled platform maintenance",
                cancelledBy: "system",
              },
            });
          }
        }

        // Cancel class if applicable
        if (appointment.class) {
          const classEvent = appointment.class;
          await tx.class.update({
            where: { id: classEvent.id },
            data: { status: "CANCELLED" },
          });

          const consultantUser = classEvent.classPlan?.consultantProfile?.user;
          const participantIds = slots.flatMap((s: AffectedSlot) =>
            s.user.map((u) => u.id),
          );
          const userIds = Array.from(new Set(participantIds));
          if (consultantUser?.id && !userIds.includes(consultantUser.id)) {
            userIds.push(consultantUser.id);
          }

          if (userIds.length > 0) {
            pendingNotifications.push({
              userIds,
              data: {
                appointmentId: appointment.id,
                appointmentType: "CLASS",
                consultantName: consultantUser?.name || "Consultant",
                consulteeName: "Participants",
                planTitle: classEvent.classPlan?.title || "Class",
                dateTime: earliestSlot.startsAt.toISOString(),
                dashboardUrl: "/dashboard",
                reason: "Scheduled platform maintenance",
                cancelledBy: "system",
              },
            });
          }
        }

        // Collect SUCCEEDED payments for refund processing after the transaction.
        // We must gather these before slot/appointment deletion so the data is available.
        for (const payment of appointment.payment) {
          pendingRefunds.push(payment);
        }

        // Batch delete all affected slots for this appointment
        await tx.slotOfAppointment.deleteMany({
          where: { id: { in: slots.map((s: AffectedSlot) => s.id) } },
        });

        // Delete appointment if no other slots remain AND no payments need refunding.
        // Appointments with payments are kept alive so refund records can reference
        // the Payment FK — cascade deletion would otherwise orphan the refund.
        const remainingSlots = await tx.slotOfAppointment.count({
          where: { appointmentId: appointment.id },
        });
        if (remainingSlots === 0 && appointment.payment.length === 0) {
          await tx.appointment.delete({ where: { id: appointment.id } });
        }

        cancelled++;
      }
    },
    { maxWait: 30000, timeout: 60000 },
  );

  // Issue refunds AFTER the transaction commits.
  // The Payment records still exist (appointments with payments were not deleted).
  // On gateway failure a PENDING placeholder is created for the reconcile cron to retry.
  for (const payment of pendingRefunds) {
    try {
      const result = await createRefund({
        paymentIntentId: payment.paymentIntent,
        amount: payment.amount,
        reason: "Scheduled platform maintenance",
      });
      await prisma.refund.create({
        data: {
          amount: payment.amount,
          currency: payment.currency,
          reason: "Scheduled platform maintenance",
          status: result.status,
          refundId: result.refundId,
          paymentGateway: payment.paymentGateway,
          paymentId: payment.id,
          ...(result.metadata ? { metadata: result.metadata as Record<string, string> } : {}),
        },
      });
      refundsIssued++;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "maintenance_refund_failed",
          paymentId: payment.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      // Create a PENDING placeholder so the reconcile-pending-refunds cron can retry
      try {
        await prisma.refund.create({
          data: {
            amount: payment.amount,
            currency: payment.currency,
            reason: "Scheduled platform maintenance",
            status: "PENDING",
            refundId: `pending_${crypto.randomUUID()}`,
            paymentGateway: payment.paymentGateway,
            paymentId: payment.id,
            metadata: { error: String(err) },
          },
        });
      } catch (dbErr) {
        console.error(
          JSON.stringify({
            event: "maintenance_refund_record_failed",
            paymentId: payment.id,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      refundErrors++;
    }
  }

  // Send all notifications AFTER the transaction commits.
  // Fire-and-forget: notification failures don't affect the freeze result.
  for (const { userIds, data } of pendingNotifications) {
    try {
      await notifyAppointmentCancelled(userIds, data);
      notified += userIds.length;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "maintenance_freeze_notification_failed",
          appointmentId: data.appointmentId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_appointments_frozen",
      cancelled,
      notified,
      refundsIssued,
      refundErrors,
      windowStart: maintenanceStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timestamp: new Date().toISOString(),
    }),
  );

  return { cancelled, notified, refundsIssued, refundErrors };
}
