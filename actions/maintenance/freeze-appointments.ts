"use server";

/**
 * Appointment Freeze — called when entering OFFLINE maintenance phase.
 *
 * Finds upcoming appointments within the maintenance window,
 * cancels them with a system-initiated reason, and notifies affected users.
 */

import crypto from "crypto";

import * as Sentry from "@sentry/nextjs";

import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { createRefund } from "@/lib/payments";
import prisma from "@/lib/prisma";

type NotificationPayload = {
  userIds: string[];
  data: Parameters<typeof notifyAppointmentCancelled>[1];
};

function buildCancellationNotification(params: {
  appointmentId: string;
  appointmentType: string;
  consultantUser: { id: string; name: string | null } | null | undefined;
  participantIds: string[];
  planTitle: string;
  dateTime: string;
  consulteeName?: string;
}): NotificationPayload | null {
  const userIds = [...params.participantIds];
  if (
    params.consultantUser?.id &&
    !userIds.includes(params.consultantUser.id)
  ) {
    userIds.push(params.consultantUser.id);
  }
  if (userIds.length === 0) return null;
  return {
    userIds,
    data: {
      appointmentId: params.appointmentId,
      appointmentType: params.appointmentType,
      consultantName: params.consultantUser?.name || "Consultant",
      consulteeName: params.consulteeName || "Participants",
      planTitle: params.planTitle,
      dateTime: params.dateTime,
      dashboardUrl: "/dashboard",
      reason: "Scheduled platform maintenance",
      cancelledBy: "system",
    },
  };
}

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
          trialSession: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                },
              },
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
              consulteeProfile: {
                select: { user: { select: { id: true, name: true } } },
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
    return {
      cancelled: 0,
      notified: 0,
      refundsIssued: 0,
      refundErrors: 0,
      subscriptionsExtended: 0,
    };
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
  let subscriptionsExtended = 0;

  // Track subscription IDs affected by cancellation for scheduling period extension
  const affectedSubscriptionIds = new Set<string>();

  // Collect payment data to refund AFTER the transaction commits.
  // Payments linked to appointments that have SUCCEEDED payments are kept alive
  // (appointment not deleted) so refund records can reference them.
  type PendingRefundPayment = AffectedSlot["appointment"]["payment"][number];
  const pendingRefunds: PendingRefundPayment[] = [];

  // Collect notification payloads to send AFTER the transaction commits.
  // External API calls (Novu) cannot be rolled back, so they must run
  // outside the transaction to avoid notifying users about cancellations
  // that were later rolled back.
  const pendingNotifications: NotificationPayload[] = [];

  // Wrap all DB writes in a single transaction for atomicity.
  // If any appointment cancel fails mid-loop, all prior cancellations
  // in this batch are rolled back — preventing partial freeze state.
  await prisma.$transaction(
    async (tx) => {
      for (const appointmentId of Object.keys(slotsByAppointment)) {
        const slots = slotsByAppointment[appointmentId];
        const appointment = slots[0].appointment;
        const earliestSlot = slots.reduce((a: AffectedSlot, b: AffectedSlot) =>
          a.startsAt < b.startsAt ? a : b,
        );

        // Cancel consultation if applicable
        if (appointment.consultation) {
          const consultation = appointment.consultation;
          await tx.consultation.update({
            where: { id: consultation.id },
            data: {
              status: "CANCELLED",
              cancellationReason: "TECHNICAL_ISSUE",
              cancellationNotes:
                "Cancelled due to scheduled platform maintenance",
              cancelledAt: new Date(),
            },
          });

          const notif = buildCancellationNotification({
            appointmentId: appointment.id,
            appointmentType: "CONSULTATION",
            consultantUser:
              consultation.consultationPlan?.consultantProfile?.user,
            participantIds: consultation.requestedBy?.user?.id
              ? [consultation.requestedBy.user.id]
              : [],
            planTitle: consultation.consultationPlan?.title || "Consultation",
            dateTime: earliestSlot.startsAt.toISOString(),
            consulteeName: consultation.requestedBy?.user?.name || "User",
          });
          if (notif) pendingNotifications.push(notif);
        }

        // Cancel subscription appointment if applicable
        if (appointment.subscription) {
          const subscription = appointment.subscription;
          await tx.subscription.update({
            where: { id: subscription.id },
            data: {
              status: "CANCELLED",
              cancellationReason: "TECHNICAL_ISSUE",
              cancellationNotes:
                "Cancelled due to scheduled platform maintenance",
              cancelledAt: new Date(),
            },
          });

          affectedSubscriptionIds.add(subscription.id);

          const notif = buildCancellationNotification({
            appointmentId: appointment.id,
            appointmentType: "SUBSCRIPTION",
            consultantUser:
              subscription.subscriptionPlan?.consultantProfile?.user,
            participantIds: subscription.requestedBy?.user?.id
              ? [subscription.requestedBy.user.id]
              : [],
            planTitle: subscription.subscriptionPlan?.title || "Subscription",
            dateTime: earliestSlot.startsAt.toISOString(),
            consulteeName: subscription.requestedBy?.user?.name || "User",
          });
          if (notif) pendingNotifications.push(notif);
        }

        // Cancel webinar if applicable
        if (appointment.webinar) {
          const webinar = appointment.webinar;
          await tx.webinar.update({
            where: { id: webinar.id },
            data: { status: "CANCELLED" },
          });

          const webinarParticipantIds = Array.from(
            new Set(
              slots.flatMap((s: AffectedSlot) => s.user.map((u) => u.id)),
            ),
          );
          const notif = buildCancellationNotification({
            appointmentId: appointment.id,
            appointmentType: "WEBINAR",
            consultantUser: webinar.webinarPlan?.consultantProfile?.user,
            participantIds: webinarParticipantIds,
            planTitle: webinar.webinarPlan?.title || "Webinar",
            dateTime: earliestSlot.startsAt.toISOString(),
          });
          if (notif) pendingNotifications.push(notif);
        }

        // Cancel class if applicable
        if (appointment.class) {
          const classEvent = appointment.class;
          await tx.class.update({
            where: { id: classEvent.id },
            data: { status: "CANCELLED" },
          });

          const classParticipantIds = Array.from(
            new Set(
              slots.flatMap((s: AffectedSlot) => s.user.map((u) => u.id)),
            ),
          );
          const notif = buildCancellationNotification({
            appointmentId: appointment.id,
            appointmentType: "CLASS",
            consultantUser: classEvent.classPlan?.consultantProfile?.user,
            participantIds: classParticipantIds,
            planTitle: classEvent.classPlan?.title || "Class",
            dateTime: earliestSlot.startsAt.toISOString(),
          });
          if (notif) pendingNotifications.push(notif);
        }

        // Cancel trial session if applicable
        if (appointment.trialSession) {
          const trial = appointment.trialSession;
          await tx.trialSession.update({
            where: { id: trial.id },
            data: { status: "CANCELLED" },
          });

          const notif = buildCancellationNotification({
            appointmentId: appointment.id,
            appointmentType: "TRIAL",
            consultantUser: trial.consultantProfile?.user,
            participantIds: trial.consulteeProfile?.user?.id
              ? [trial.consulteeProfile.user.id]
              : [],
            planTitle: trial.subscriptionPlan?.title || "Trial Session",
            dateTime: earliestSlot.startsAt.toISOString(),
            consulteeName: trial.consulteeProfile?.user?.name || "User",
          });
          if (notif) pendingNotifications.push(notif);
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
  // On gateway failure a PENDING placeholder is created for the
  // reconcile-pending-refunds cron, which RECONCILES (matches an existing
  // gateway refund by amount + time window) or marks the row FAILED after
  // 24h and notifies the payer (#779) — it does NOT re-initiate the gateway
  // call, so a throw here means no money moved until an operator retries.
  for (const payment of pendingRefunds) {
    try {
      const result = await createRefund({
        paymentIntentId: payment.paymentIntent,
        amount: payment.amount,
        reason: "Scheduled platform maintenance",
      });
      await prisma.refund.create({
        data: {
          amountPaise: payment.amount,
          currency: payment.currency,
          reason: "Scheduled platform maintenance",
          status: result.status,
          refundId: result.refundId,
          paymentGateway: payment.paymentGateway,
          paymentId: payment.id,
          ...(result.metadata
            ? { metadata: result.metadata as Record<string, string> }
            : {}),
        },
      });
      refundsIssued++;
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
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
            amountPaise: payment.amount,
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
        Sentry.captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), { tags: { subsystem: "maintenance" }, level: "fatal" });
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

  // Extend scheduling period for affected subscriptions.
  // Only extend subscriptions that still have future slots (partial cancellation).
  const subscriptionIdList = Array.from(affectedSubscriptionIds);
  if (subscriptionIdList.length > 0) {
    const maintenanceDurationMs =
      windowEnd.getTime() - maintenanceStart.getTime();
    for (const subId of subscriptionIdList) {
      try {
        const sub = await prisma.subscription.findUnique({
          where: { id: subId },
          select: { schedulingPeriodEndsAt: true },
        });
        if (sub?.schedulingPeriodEndsAt) {
          await prisma.subscription.update({
            where: { id: subId },
            data: {
              schedulingPeriodEndsAt: new Date(
                sub.schedulingPeriodEndsAt.getTime() + maintenanceDurationMs,
              ),
            },
          });
          subscriptionsExtended++;
        }
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
        console.error(
          JSON.stringify({
            event: "maintenance_subscription_extend_failed",
            subscriptionId: subId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  // Send all notifications AFTER the transaction commits.
  // Fire-and-forget: notification failures don't affect the freeze result.
  for (const { userIds, data } of pendingNotifications) {
    try {
      await notifyAppointmentCancelled(userIds, data);
      notified += userIds.length;
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" }, level: "warning" });
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
      subscriptionsExtended,
      windowStart: maintenanceStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    cancelled,
    notified,
    refundsIssued,
    refundErrors,
    subscriptionsExtended,
  };
}
