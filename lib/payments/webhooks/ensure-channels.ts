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

function resolveBuyerIds(
  paidBuyerIds: string[],
  buyerUserIds?: string[],
): string[] {
  if (!buyerUserIds || buyerUserIds.length === 0) {
    return paidBuyerIds;
  }
  const paidBuyerSet = new Set(paidBuyerIds);
  return buyerUserIds.filter((id) => paidBuyerSet.has(id));
}

async function ensureChannelsForBuyers(args: {
  eventType: string;
  consultantUserId: string;
  dmOrgId: string | null;
  buyerIds: string[];
  consultationId?: string;
  subscriptionId?: string;
  webinarId?: string;
  classId?: string;
}): Promise<boolean> {
  const {
    eventType,
    consultantUserId,
    dmOrgId,
    buyerIds,
    consultationId,
    subscriptionId,
    webinarId,
    classId,
  } = args;
  const isOneToOne =
    (eventType === "CONSULTATION" && Boolean(consultationId)) ||
    (eventType === "SUBSCRIPTION" && Boolean(subscriptionId));
  const eventChannelSpec =
    eventType === "WEBINAR" && webinarId
      ? { kind: "webinar" as const, id: webinarId }
      : eventType === "CLASS" && classId
        ? { kind: "class" as const, id: classId }
        : null;

  if (!isOneToOne && !eventChannelSpec) {
    return false;
  }

  for (const userId of buyerIds) {
    if (eventChannelSpec) {
      await addUserToEventChannel(
        eventChannelSpec.kind,
        eventChannelSpec.id,
        userId,
      );
    }
    if (consultantUserId !== userId) {
      await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
    }
  }
  return true;
}

/**
 * Ensures Stream chat channels for a confirmed, paid appointment and stamps
 * `Appointment.chatChannelEnsuredAt` once complete.
 * The appointment row is the outbox (`chatChannelEnsuredAt IS NULL`).
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
        select: {
          consultantProfile: { select: { userId: true } },
        },
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
    // A stamp means ensured or intentionally skipped, so the sweep never revisits the row.
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

  const paidBuyerIds = appointment.payment?.map((p) => p.userId) ?? [];
  const buyerIds = resolveBuyerIds(paidBuyerIds, buyerUserIds);
  if (buyerIds.length === 0) {
    return { ensured: false, reason: "no_succeeded_payment" };
  }

  const dmOrgId = bookingOrgId({
    consultationPlan: appointment.consultation?.consultationPlan,
    subscriptionPlan: appointment.subscription?.subscriptionPlan,
    webinarPlan: appointment.webinar?.webinarPlan,
    classPlan: appointment.class?.classPlan,
    appointment,
  });

  const matched = await ensureChannelsForBuyers({
    eventType,
    consultantUserId,
    dmOrgId,
    buyerIds,
    consultationId: appointment.consultation?.id,
    subscriptionId: appointment.subscription?.id,
    webinarId: appointment.webinar?.id,
    classId: appointment.class?.id,
  });
  if (!matched) {
    return { ensured: false, reason: "no_channel_branch_for_appointment" };
  }

  // A stamp means ensured or intentionally skipped, so the sweep never revisits the row.
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
