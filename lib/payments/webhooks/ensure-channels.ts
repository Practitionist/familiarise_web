import prisma from "@/lib/prisma";
import { paidParticipant } from "@/lib/booking/participants";
import { addUserToEventChannel } from "@/lib/stream/event-channel-service";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { bookingOrgId } from "@/lib/stream-utils";
import { addSeatHoldersToOpenCalls } from "@/lib/meetings/seat-call-members";
import { reportSentryError } from "@/lib/observability/report";
import { fenceSeatGrants } from "@/lib/stream/access-revocation";

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
  appointmentId: string;
  eventType: string;
  consultantUserId: string;
  dmOrgId: string | null;
  buyerIds: string[];
  consultationId?: string;
  subscriptionId?: string;
  webinarId?: string;
  classId?: string;
}): Promise<"unmatched" | "incomplete" | "ensured"> {
  const {
    appointmentId,
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
    return "unmatched";
  }

  const syncedBuyerIds: string[] = [];
  let incomplete = false;
  try {
    for (const userId of buyerIds) {
      if (eventChannelSpec) {
        const joined = await addUserToEventChannel(
          eventChannelSpec.kind,
          eventChannelSpec.id,
          userId,
        );
        if (joined.success) syncedBuyerIds.push(userId);
        // A refused account is a deliberate skip; a missing member is retried by the sweep.
        if (joined.reason === "member_not_added") incomplete = true;
      }
      if (consultantUserId !== userId) {
        await createDirectMessageChannel(consultantUserId, userId, dmOrgId);
      }
    }
    if (eventChannelSpec && syncedBuyerIds.length > 0) {
      try {
        await addSeatHoldersToOpenCalls(appointmentId, syncedBuyerIds);
      } catch (error) {
        reportSentryError(error, {
          subsystem: "stream",
          op: "ensureChannels.seatCallMembers",
          extra: { appointmentId },
        });
      }
    }
  } finally {
    if (eventChannelSpec) {
      // Runs even when a grant throws: a seat that ended after the roster read is taken back from chat, DMs and rooms.
      await fenceSeatGrants(appointmentId, buyerIds);
    }
  }
  return incomplete ? "incomplete" : "ensured";
}

// A stamp means ensured or intentionally skipped, so the sweep never revisits the row.
async function stampChannelsEnsured(appointmentId: string): Promise<void> {
  await prisma.appointment.updateMany({
    where: { id: appointmentId, chatChannelEnsuredAt: null },
    data: { chatChannelEnsuredAt: new Date() },
  });
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
      // A payment outlives the seat it bought, so event members come from seats holding access.
      participants: {
        where: { role: "CONSULTEE", ...paidParticipant() },
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
    await stampChannelsEnsured(appointmentId);
    return { ensured: true, skipped: "trial_chat_blocked" };
  }

  const consultantUserId = consultantProfile?.userId;
  if (!consultantUserId) {
    return { ensured: false, reason: "consultant_not_resolved" };
  }

  const isGroupEvent = eventType === "WEBINAR" || eventType === "CLASS";
  const paidBuyerIds = isGroupEvent
    ? appointment.participants.map((p) => p.userId)
    : (appointment.payment?.map((p) => p.userId) ?? []);
  if (isGroupEvent && paidBuyerIds.length === 0) {
    // No seat holds access, so nothing is owed; the next registration runs its own sync.
    await stampChannelsEnsured(appointmentId);
    return { ensured: true, skipped: "no_seat_holding_access" };
  }
  const buyerIds = resolveBuyerIds(paidBuyerIds, buyerUserIds);
  if (buyerIds.length === 0) {
    return {
      ensured: false,
      reason: isGroupEvent ? "no_seat_holding_access" : "no_succeeded_payment",
    };
  }

  const dmOrgId = bookingOrgId({
    consultationPlan: appointment.consultation?.consultationPlan,
    subscriptionPlan: appointment.subscription?.subscriptionPlan,
    webinarPlan: appointment.webinar?.webinarPlan,
    classPlan: appointment.class?.classPlan,
    appointment,
  });

  const matched = await ensureChannelsForBuyers({
    appointmentId,
    eventType,
    consultantUserId,
    dmOrgId,
    buyerIds,
    consultationId: appointment.consultation?.id,
    subscriptionId: appointment.subscription?.id,
    webinarId: appointment.webinar?.id,
    classId: appointment.class?.id,
  });
  if (matched === "unmatched") {
    return { ensured: false, reason: "no_channel_branch_for_appointment" };
  }
  if (matched === "incomplete") {
    return { ensured: false, reason: "event_channel_member_not_added" };
  }

  await stampChannelsEnsured(appointmentId);

  streamLogger.info("Stream channels ensured for appointment", {
    appointmentType: eventType,
    appointmentId,
    buyers: buyerIds.length,
  });

  return { ensured: true };
}
