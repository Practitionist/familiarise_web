import { createChannel } from "@/actions/stream/chat/channel.action";
import { liveParticipant } from "@/lib/booking/participants";
import prisma from "@/lib/prisma";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import { getStreamChatClient, isStreamConfigured } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getDmChannelId } from "@/lib/stream-utils";
import type { StageQuestion } from "@/lib/meetings/stage-qa";

export interface CanonicalMeetingChannel {
  channelType: "messaging" | "team";
  channelId: string;
  consultantUserId?: string;
  consulteeUserId?: string;
  organizationId?: string | null;
}

type AppointmentForMirroring = {
  id?: string;
  appointmentType?: string | null;
  consultation?: {
    consultationPlan?: {
      organizationId?: string | null;
      consultantProfile?: { userId?: string | null } | null;
    } | null;
  } | null;
  subscription?: {
    subscriptionPlan?: {
      organizationId?: string | null;
      consultantProfile?: { userId?: string | null } | null;
    } | null;
  } | null;
  webinar?: { id?: string | null } | null;
  class?: { id?: string | null } | null;
  trial?: unknown;
};

/**
 * Resolves the canonical Stream Chat channel for a session:
 * - 1:1 Consultations & Subscriptions -> persistent DM (`dm-*` / `dmo-*`)
 * - Webinars & Classes -> cohort channel (`webinar-*` / `class-*`, 7d freeze / 90d retention)
 * - Trials -> null (chat disabled)
 */
export async function resolveCanonicalMeetingChannel(
  appointment: AppointmentForMirroring | null | undefined,
): Promise<CanonicalMeetingChannel | null> {
  if (!appointment) return null;

  const type =
    appointment.appointmentType ??
    (appointment.webinar?.id
      ? "WEBINAR"
      : appointment.class?.id
        ? "CLASS"
        : null);

  if (!type || type === "TRIAL") return null;

  if (appointment.webinar?.id) {
    return {
      channelType: "team",
      channelId: `${WEBINAR_PREFIX}${appointment.webinar.id}`,
    };
  }

  if (appointment.class?.id) {
    return {
      channelType: "team",
      channelId: `${CLASS_PREFIX}${appointment.class.id}`,
    };
  }

  const consultantUserId =
    appointment.consultation?.consultationPlan?.consultantProfile?.userId ??
    appointment.subscription?.subscriptionPlan?.consultantProfile?.userId ??
    null;
  const organizationId =
    appointment.consultation?.consultationPlan?.organizationId ??
    appointment.subscription?.subscriptionPlan?.organizationId ??
    null;

  if (!consultantUserId || !appointment.id) return null;

  const consulteeSeat = await prisma.appointmentParticipant.findFirst({
    where: {
      appointmentId: appointment.id,
      userId: { not: consultantUserId },
      ...liveParticipant(),
    },
    select: { userId: true },
  });

  if (!consulteeSeat?.userId) return null;

  return {
    channelType: "messaging",
    channelId: getDmChannelId(
      consultantUserId,
      consulteeSeat.userId,
      organizationId,
    ),
    consultantUserId,
    consulteeUserId: consulteeSeat.userId,
    organizationId,
  };
}

/**
 * Mirrors an in-room chat message into the session's canonical Stream Chat channel
 * so pre-call, live in-room, and post-call messages share one history.
 */
export async function mirrorChatMessageToStreamChannel(args: {
  appointment: AppointmentForMirroring | null | undefined;
  senderUserId: string;
  text: string;
  callId: string;
  roomMessageId: string;
}): Promise<string | null> {
  if (!isStreamConfigured()) return null;

  try {
    const target = await resolveCanonicalMeetingChannel(args.appointment);
    if (!target) return null;

    if (
      target.channelType === "messaging" &&
      target.consultantUserId &&
      target.consulteeUserId
    ) {
      await createChannel({
        channelType: "messaging",
        channelId: target.channelId,
        members: [target.consultantUserId, target.consulteeUserId],
        createdById: args.senderUserId,
        organizationId: target.organizationId,
      });
    }

    const chat = getStreamChatClient();
    const res = await chat
      .channel(target.channelType, target.channelId)
      .sendMessage({
        id: args.roomMessageId,
        text: args.text,
        user_id: args.senderUserId,
      });

    return res.message?.id ?? null;
  } catch (error) {
    streamLogger.debug("Best-effort Stream Chat room mirror skipped", {
      callId: args.callId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Mirrors an answered Q&A question into the canonical Stream Chat channel
 * when the host posts a written answer so attendees keep the Q&A record post-session.
 */
export async function mirrorAnsweredQuestionToStreamChannel(args: {
  appointment: AppointmentForMirroring | null | undefined;
  hostUserId: string;
  callId: string;
  question: StageQuestion;
}): Promise<void> {
  if (!isStreamConfigured() || !args.question.answerText) return;

  try {
    const target = await resolveCanonicalMeetingChannel(args.appointment);
    if (!target) return;

    if (
      target.channelType === "messaging" &&
      target.consultantUserId &&
      target.consulteeUserId
    ) {
      await createChannel({
        channelType: "messaging",
        channelId: target.channelId,
        members: [target.consultantUserId, target.consulteeUserId],
        createdById: args.hostUserId,
        organizationId: target.organizationId,
      });
    }

    const formatted = `Q (${args.question.authorName}): ${args.question.text}\nA: ${args.question.answerText}`;
    await getStreamChatClient()
      .channel(target.channelType, target.channelId)
      .sendMessage({
        id: `qa-${args.question.id}`,
        text: formatted,
        user_id: args.hostUserId,
      });
  } catch (error) {
    streamLogger.debug("Best-effort Q&A answer mirror skipped", {
      callId: args.callId,
      questionId: args.question.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
