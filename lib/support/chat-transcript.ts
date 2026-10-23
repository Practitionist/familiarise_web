/**
 * The audited staff transcript read. Messages come from Stream server-side
 * (`channel.query`, never `watch()`), are cut to the grant's window and scope,
 * and every page writes a strict SystemEvent before it is returned: a page
 * that cannot be audited is not served.
 */

import type { MessageResponse } from "stream-chat";

import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { isMissingChannelError } from "@/lib/stream/support-intervention";
import { isSupportStreamUser } from "@/lib/stream/support-user";
import type { TranscriptMessage, TranscriptPage } from "@/schemas/support-chat";
import { liveGrantForReader } from "./chat-access";

export const SUPPORT_CHAT_ACCESS_EVENT_CATEGORY = "SUPPORT_CHAT_ACCESS";
const PAGE_LIMIT = 200;
/** Group channels filter to the scope, so a sparse page reads a few more. */
const MAX_RAW_PAGES = 3;
const FILL_TARGET = 50;
/** Soft-deleted text is one extra read per message; bounded per page. */
const MAX_DELETED_LOOKUPS = 20;

type Role = TranscriptMessage["role"];

function roleOf(message: MessageResponse, reporterId: string | null): Role {
  const userId = message.user?.id ?? null;
  if (message.type === "system" || !userId) return "system";
  if (isSupportStreamUser(userId)) return "support";
  if (reporterId && userId === reporterId) return "reporter";
  return reporterId ? "target" : "party";
}

function inScope(message: MessageResponse, scopeUserIds: Set<string>) {
  const userId = message.user?.id;
  return (
    message.type === "system" ||
    !userId ||
    isSupportStreamUser(userId) ||
    scopeUserIds.has(userId)
  );
}

function createdAtOf(message: MessageResponse): Date {
  return new Date(message.created_at ?? 0);
}

async function deletedText(messageId: string): Promise<string> {
  const res = await withStreamCircuitBreaker(() =>
    getStreamChatClient().getMessage(messageId, {
      show_deleted_message: true,
    }),
  );
  return res.message?.text ?? "";
}

type StreamChannel = ReturnType<
  ReturnType<typeof getStreamChatClient>["channel"]
>;

async function queryRawPage(
  channel: StreamChannel,
  cursor: string | undefined,
): Promise<MessageResponse[]> {
  try {
    const res = await withStreamCircuitBreaker(() =>
      channel.query({
        state: true,
        watch: false,
        presence: false,
        messages: {
          limit: PAGE_LIMIT,
          ...(cursor ? { id_lt: cursor } : {}),
        },
      }),
    );
    return res.messages ?? [];
  } catch (err) {
    if (isMissingChannelError(err))
      throw new OpsRefusal(
        "CHAT_NOT_FOUND",
        "This booking chat no longer exists.",
        404,
      );
    throw err;
  }
}

/** Pages back from `before` until enough in-window, in-scope messages are kept. */
async function collectWindow(
  channel: StreamChannel,
  windowStart: Date,
  scopeUserIds: Set<string>,
  before: string | undefined,
) {
  const kept: MessageResponse[] = [];
  let cursor = before;
  let reachedStart = false;
  for (let page = 0; page < MAX_RAW_PAGES && !reachedStart; page++) {
    const raw = await queryRawPage(channel, cursor);
    const oldest = raw[0];
    if (!oldest || raw.length < PAGE_LIMIT) reachedStart = true;
    if (oldest && createdAtOf(oldest) < windowStart) reachedStart = true;
    if (oldest) cursor = oldest.id;
    const inWindow = raw.filter(
      (m) => createdAtOf(m) >= windowStart && inScope(m, scopeUserIds),
    );
    kept.unshift(...inWindow);
    if (kept.length >= FILL_TARGET) break;
  }
  return { kept, cursor, reachedStart };
}

function attachmentsOf(m: MessageResponse): TranscriptMessage["attachments"] {
  return (m.attachments ?? []).map((a) => ({
    type: a.type ?? "file",
    name: a.title ?? a.fallback ?? a.mime_type ?? a.type ?? "attachment",
  }));
}

async function toTranscriptMessages(
  kept: MessageResponse[],
  reporterId: string | null,
): Promise<TranscriptMessage[]> {
  let lookups = 0;
  const messages: TranscriptMessage[] = [];
  for (const m of kept) {
    const deleted = m.type === "deleted" || Boolean(m.deleted_at);
    let text = m.text ?? "";
    if (deleted && lookups < MAX_DELETED_LOOKUPS) {
      lookups += 1;
      text = await deletedText(m.id);
    }
    messages.push({
      id: m.id,
      userId: m.user?.id ?? null,
      userName: m.user?.name ?? null,
      role: roleOf(m, reporterId),
      text,
      attachments: attachmentsOf(m),
      createdAt: createdAtOf(m).toISOString(),
      deletedBySender: deleted,
    });
  }
  return messages;
}

/** Reads one transcript page under a live grant and audits it before returning. */
export async function readTranscriptPage(input: {
  caseId: string;
  grantId: string;
  actor: { userId: string; role: string };
  before?: string;
  now?: Date;
}): Promise<TranscriptPage> {
  const now = input.now ?? new Date();
  const grant = await liveGrantForReader(prisma, {
    caseId: input.caseId,
    grantId: input.grantId,
    actorId: input.actor.userId,
    now,
  });
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: input.caseId },
    select: { requesterUserId: true },
  });
  const scopeUserIds = new Set(grant.scopeUserIds);
  const reporterId =
    supportCase && scopeUserIds.has(supportCase.requesterUserId)
      ? supportCase.requesterUserId
      : null;
  const channel = getStreamChatClient().channel(
    grant.channelType,
    grant.channelId,
  );

  const { kept, cursor, reachedStart } = await collectWindow(
    channel,
    grant.windowStart,
    scopeUserIds,
    input.before,
  );
  const messages = await toTranscriptMessages(kept, reporterId);

  await recordSystemEvent({
    category: SUPPORT_CHAT_ACCESS_EVENT_CATEGORY,
    severity: "WARN",
    message: "Platform operator read a booking chat transcript page",
    correlationId: grant.id,
    context: {
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      caseId: input.caseId,
      grantId: grant.id,
      grantKind: grant.kind,
      channelCid: `${grant.channelType}:${grant.channelId}`,
      before: input.before ?? null,
      messageCount: messages.length,
      messageIds: messages.map((m) => m.id),
    },
    strict: true,
  });

  return {
    messages,
    nextBefore: reachedStart ? null : (cursor ?? null),
    windowStart: grant.windowStart.toISOString(),
  };
}
