import prisma from "@/lib/prisma";
import { addUserToEventChannel } from "@/lib/stream/event-channel-service";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";

export interface EnsureChannelsResult {
  /** True when every buyer's channel exists and the appointment is stamped. */
  ensured: boolean;
  /** Why nothing was ensured. Present only when `ensured` is false. */
  reason?: string;
  /** Why channel creation was intentionally bypassed while still stamping completion. */
  skipped?: string;
}

/**
 * Ensures Stream chat channels for a confirmed, paid appointment and stamps
 * `Appointment.chatChannelEnsuredAt` once complete.
 */
export async function ensureChannelsForAppointment(
  appointmentId: string,
  buyerUserIds?: string[],
): Promise<EnsureChannelsResult> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { userId: true },
        orderBy: { createdAt: "asc" },
      },
      consultation: {
        select: {
          id: true,
          consultationPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      subscription: {
        select: {
          id: true,
          subscriptionPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
          appointment: { select: { organizationId: true } },
        },
      },
      webinar: {
        select: {
          id: true,
          webinarPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      class: {
        select: {
          id: true,
          classPlan: {
            select: {
              organizationId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      trial: {
        select: { consultantProfile: { select: { userId: true } } },
      },
    },
  });

  if (!appointment) {
    return { ensured: false, reason: "appointment_not_found" };
  }

  const consultantProfile =
    appointment.consultation?.consultationPlan?.consultantProfile ||
    appointment.subscription?.subscriptionPlan?.consultantProfile ||
    appointment.webinar?.webinarPlan?.consultantProfile ||
    appointment.class?.classPlan?.consultantProfile ||
    appointment.trial?.consultantProfile;

  const eventType = appointment.appointmentType;
  if (eventType === "TRIAL" || appointment.trial) {
    await prisma.appointment.updateMany({
      where: { id: appointmentId, chatChannelEnsuredAt: null },
      data: { chatChannelEnsuredAt: new Date() },
    });
    return { ensured: true, skipped: "trial_chat_blocked" };
  }

  const consultantUserId = consultantProfile?.userId;
  if (!consultantUserId) {
    return { ensured: false, reason: "consultant_not_resolved" };
  }

  const buyerIds =
    buyerUserIds && buyerUserIds.length > 0
      ? buyerUserIds
      : (appointment.payment?.map((p) => p.userId) ?? []);
  if (buyerIds.length === 0) {
    return { ensured: false, reason: "no_succeeded_payment" };
  }

  const consultation = appointment.consultation;
  const subscription = appointment.subscription;
  const webinar = appointment.webinar;
  const classEvent = appointment.class;

  const dmOrgId = bookingOrgId({
    consultationPlan: consultation?.consultationPlan,
    subscriptionPlan: subscription?.subscriptionPlan,
    webinarPlan: webinar?.webinarPlan,
    classPlan: classEvent?.classPlan,
    appointment,
  });

  for (const userId of buyerIds) {
    if (
      (eventType === "CONSULTATION" && consultation) ||
      (eventType === "SUBSCRIPTION" && subscription)
    ) {
      if (consultantUserId !== userId) {
        await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
      }
    } else if (eventType === "WEBINAR" && webinar) {
      await addUserToEventChannel("webinar", webinar.id, userId);
      if (consultantUserId !== userId) {
        await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
      }
    } else if (eventType === "CLASS" && classEvent) {
      await addUserToEventChannel("class", classEvent.id, userId);
      if (consultantUserId !== userId) {
        await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
      }
    } else {
      return { ensured: false, reason: "no_channel_branch_for_appointment" };
    }
  }

  await prisma.appointment.updateMany({
    where: { id: appointmentId, chatChannelEnsuredAt: null },
    data: { chatChannelEnsuredAt: new Date() },
  });

  streamLogger.info("Stream channels ensured for appointment", {
    appointmentType: eventType,
    appointmentId,
    buyers: buyerIds.length,
  });

  return { ensured: true };
}
