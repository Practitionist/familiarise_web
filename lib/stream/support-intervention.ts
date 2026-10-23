/**
 * The Stream side of a support intervention. A dedicated, never-logged-in
 * `familiarise-support` user joins the booking chat as a visible member, with
 * a system message on join and on leave; staff post as it through an audited
 * server route. Server client only, never inside a Prisma transaction, never
 * `watch()`: a server-side watch can create phantom channels.
 */

import type { Channel } from "stream-chat";

import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";
import {
  getStreamChatClient,
  isExpectedStreamError,
  streamErrorCode,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { getAppUrl } from "@/lib/url";
import {
  SUPPORT_STREAM_USER_ID,
  SUPPORT_STREAM_USER_NAME,
} from "@/lib/stream/support-user";

/** Generic on purpose: a group channel must never learn who reported. */
export function supportJoinText(): string {
  return `${SUPPORT_STREAM_USER_NAME} has joined this chat to help with a reported issue. Our team can read this conversation while the issue is open. How we review messages: ${getAppUrl()}${MESSAGE_REVIEW_ARTICLE_HREF}`;
}
export const SUPPORT_LEAVE_TEXT = `${SUPPORT_STREAM_USER_NAME} has left this chat.`;

export type ChannelProbe =
  { exists: false } | { exists: true; frozen: boolean };

/** A channel that was never created, or deleted by retention, answers "not found". */
export function isMissingChannelError(err: unknown): boolean {
  if (isExpectedStreamError(err)) return true;
  // Server-side query of a never-created channel fails asking for a creator.
  return (
    streamErrorCode(err) === 4 &&
    err instanceof Error &&
    /created_by/i.test(err.message)
  );
}

function channelOf(channelType: string, channelId: string): Channel {
  return getStreamChatClient().channel(channelType, channelId);
}

/** Existence and frozen state without creating or watching the channel. */
export async function probeSupportChannel(
  channelType: string,
  channelId: string,
): Promise<ChannelProbe> {
  const chat = getStreamChatClient();
  const [channel] = await withStreamCircuitBreaker(() =>
    chat.queryChannels({ cid: { $eq: `${channelType}:${channelId}` } }, [], {
      limit: 1,
      state: true,
      watch: false,
      presence: false,
      message_limit: 0,
      member_limit: 0,
    }),
  );
  if (!channel) return { exists: false };
  return { exists: true, frozen: channel.data?.frozen === true };
}

async function ensureSupportUser(): Promise<void> {
  await withStreamCircuitBreaker(() =>
    getStreamChatClient().upsertUser({
      id: SUPPORT_STREAM_USER_ID,
      name: SUPPORT_STREAM_USER_NAME,
      role: "user",
    }),
  );
}

/** Stream answers a reused message id with an "already exists" input error. */
function isDuplicateMessage(err: unknown): boolean {
  return (
    streamErrorCode(err) === 4 &&
    err instanceof Error &&
    /already exists/i.test(err.message)
  );
}

async function sendSystemNotice(
  channel: Channel,
  id: string,
  text: string,
  supportEvent: "support_joined" | "support_left",
): Promise<void> {
  try {
    await withStreamCircuitBreaker(() =>
      channel.sendMessage({
        id,
        text,
        type: "system",
        user_id: SUPPORT_STREAM_USER_ID,
        support_event: supportEvent,
      }),
    );
  } catch (err) {
    if (!isDuplicateMessage(err)) throw err;
  }
}

export type JoinOutcome = "joined" | "skipped" | "frozen" | "gone";

/**
 * Seats Familiarise Support for a live intervention: upsert the support user,
 * add it as a member, stamp `streamJoinedAt`, then announce. The stamp follows
 * the membership so the leave pass always finds a seat it must clear.
 */
export async function joinIntervention(
  grantId: string,
  now = new Date(),
): Promise<JoinOutcome> {
  const grant = await prisma.supportCaseChatAccess.findUnique({
    where: { id: grantId },
    select: {
      kind: true,
      channelType: true,
      channelId: true,
      endedAt: true,
      expiresAt: true,
      streamJoinedAt: true,
    },
  });
  if (
    !grant ||
    grant.kind !== "INTERVENE" ||
    grant.endedAt ||
    grant.streamJoinedAt ||
    grant.expiresAt <= now
  )
    return "skipped";
  const probe = await probeSupportChannel(grant.channelType, grant.channelId);
  if (!probe.exists) return "gone";
  if (probe.frozen) return "frozen";
  await ensureSupportUser();
  const channel = channelOf(grant.channelType, grant.channelId);
  await withStreamCircuitBreaker(() =>
    channel.addMembers([SUPPORT_STREAM_USER_ID]),
  );
  await prisma.supportCaseChatAccess.updateMany({
    where: { id: grantId, streamJoinedAt: null },
    data: { streamJoinedAt: now },
  });
  await sendSystemNotice(
    channel,
    `fs-join-${grantId}`,
    supportJoinText(),
    "support_joined",
  );
  return "joined";
}

export type LeaveOutcome = "left" | "handed-over" | "skipped";

/**
 * Removes Familiarise Support for an ended intervention, announcing before the
 * removal. Another seated, unexpired intervention on the same channel keeps the
 * seat; a missing channel counts as left.
 */
export async function leaveIntervention(
  grantId: string,
  now = new Date(),
): Promise<LeaveOutcome> {
  const grant = await prisma.supportCaseChatAccess.findUnique({
    where: { id: grantId },
    select: {
      kind: true,
      channelType: true,
      channelId: true,
      endedAt: true,
      streamJoinedAt: true,
      streamLeftAt: true,
    },
  });
  if (
    !grant ||
    grant.kind !== "INTERVENE" ||
    !grant.endedAt ||
    !grant.streamJoinedAt ||
    grant.streamLeftAt
  )
    return "skipped";
  const successor = await prisma.supportCaseChatAccess.findFirst({
    where: {
      kind: "INTERVENE",
      channelType: grant.channelType,
      channelId: grant.channelId,
      streamJoinedAt: { not: null },
      endedAt: null,
      expiresAt: { gt: now },
      id: { not: grantId },
    },
    select: { id: true },
  });
  let outcome: LeaveOutcome = "handed-over";
  if (!successor) {
    const channel = channelOf(grant.channelType, grant.channelId);
    try {
      await sendSystemNotice(
        channel,
        `fs-leave-${grantId}`,
        SUPPORT_LEAVE_TEXT,
        "support_left",
      );
      await withStreamCircuitBreaker(() =>
        channel.removeMembers([SUPPORT_STREAM_USER_ID]),
      );
    } catch (err) {
      if (!isMissingChannelError(err)) throw err;
    }
    outcome = "left";
  }
  await prisma.supportCaseChatAccess.updateMany({
    where: { id: grantId, streamLeftAt: null },
    data: { streamLeftAt: now },
  });
  return outcome;
}

/** Leaves every ended intervention on the case that still holds its seat. */
export async function leavePendingInterventions(caseId: string) {
  const pending = await prisma.supportCaseChatAccess.findMany({
    where: {
      caseId,
      kind: "INTERVENE",
      endedAt: { not: null },
      streamJoinedAt: { not: null },
      streamLeftAt: null,
    },
    select: { id: true },
  });
  for (const grant of pending) await leaveIntervention(grant.id);
}

/** Deterministic, so a retried post is the same Stream message. */
export function supportMessageId(grantId: string, clientActionId: string) {
  return `fs-${grantId}-${clientActionId}`;
}

/**
 * Posts a staff message as Familiarise Support. The audit (case event and ops
 * row) commits before the send: an attempted send with an audit row is
 * acceptable, a sent message without one is not. The staff identity never
 * enters the Stream payload, which every member can read.
 */
export async function postSupportMessage(input: {
  caseId: string;
  grantId: string;
  actor: { userId: string; role: string };
  clientActionId: string;
  text: string;
  now?: Date;
}): Promise<{ messageId: string; replayed: boolean }> {
  const now = input.now ?? new Date();
  const grant = await prisma.supportCaseChatAccess.findFirst({
    where: { id: input.grantId, caseId: input.caseId, kind: "INTERVENE" },
    select: {
      channelType: true,
      channelId: true,
      endedAt: true,
      expiresAt: true,
      streamJoinedAt: true,
    },
  });
  if (!grant)
    throw new OpsRefusal("GRANT_NOT_FOUND", "Intervention not found.", 404);
  if (grant.endedAt || grant.expiresAt <= now)
    throw new OpsRefusal(
      "GRANT_ENDED",
      "This intervention has ended; start a new one to post.",
      410,
    );
  if (!grant.streamJoinedAt)
    throw new OpsRefusal(
      "NOT_JOINED",
      "Familiarise Support hasn't joined the chat yet; try again shortly.",
    );
  const messageId = supportMessageId(input.grantId, input.clientActionId);
  const replayed = await prisma.$transaction(async (tx) => {
    const prior = await tx.supportCaseEvent.findFirst({
      where: {
        caseId: input.caseId,
        kind: "CHAT_SUPPORT_MESSAGE",
        toValue: messageId,
      },
      select: { actorId: true },
    });
    if (prior) {
      if (prior.actorId !== input.actor.userId)
        throw new OpsRefusal(
          "IDEMPOTENCY_KEY_REUSED",
          "This message was already sent by another operator.",
        );
      return true;
    }
    await tx.supportCaseEvent.create({
      data: {
        caseId: input.caseId,
        actorId: input.actor.userId,
        kind: "CHAT_SUPPORT_MESSAGE",
        fromValue: input.grantId,
        toValue: messageId,
        createdAt: now,
      },
    });
    await recordOpsAction(tx, {
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      surface: "supportChat.intervene",
      action: "support.chat.message.post",
      targetKind: "SupportCaseChatAccess",
      targetId: input.grantId,
      reason: "Posted as Familiarise Support in the booking chat",
      after: {
        caseId: input.caseId,
        streamMessageId: messageId,
        characters: input.text.length,
      },
      correlationId: `support-case:${input.caseId}`,
    });
    return false;
  });
  const channel = channelOf(grant.channelType, grant.channelId);
  try {
    await withStreamCircuitBreaker(() =>
      channel.sendMessage({
        id: messageId,
        text: input.text,
        user_id: SUPPORT_STREAM_USER_ID,
        support_message: true,
      }),
    );
  } catch (err) {
    if (!isDuplicateMessage(err)) throw err;
    return { messageId, replayed: true };
  }
  return { messageId, replayed };
}
