/**
 * `user.unread_message_reminder` → one unread digest (email plus bell) per user
 * per 30-minute window. Stream ids are our user ids; the support user and any id
 * without a live, unbanned, unerased user row are skipped. Message text is never
 * read: the schema does not declare it.
 */
import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { liveParticipant } from "@/lib/booking/participants";
import {
  CHAT_UNREAD_DIGEST_EMAIL_TYPE,
  chatDigestLine,
  prepareChatUnreadDigestEmail,
  type ChatDigestThread,
} from "@/lib/email/senders/chat";
import { stagePreparedEmails } from "@/lib/email/send-to-recipients";
import { DEFAULT_NOTIFICATION_TIMEZONE } from "@/lib/novu/humanize";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { DM_ORG_PREFIX } from "@/lib/stream-channel-ids";
import { streamLogger } from "@/lib/stream-logger";
import { isSupportStreamUser } from "@/lib/stream/support-user";
import { resolveViewerZone } from "@/lib/time/viewer-zone";
import { getAppUrl } from "@/lib/url";
import type { StreamUnreadMessageReminderEvent } from "@/schemas/webhooks/stream";

/** Equal to the app's `reminders_interval` in the control-plane contract. */
export const CHAT_DIGEST_WINDOW_MS = 30 * 60 * 1000;
export const CHAT_DIGEST_SCOPE = "stream.chat-digest";
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const STREAM_MESSAGE_SAMPLE = 5;

export function digestWindowStart(createdAt: Date): Date {
  return new Date(
    Math.floor(createdAt.getTime() / CHAT_DIGEST_WINDOW_MS) *
      CHAT_DIGEST_WINDOW_MS,
  );
}

export function chatDigestDedupeKey(userId: string, windowStart: Date): string {
  return `chat-digest:${userId}:${windowStart.toISOString()}`;
}

type ReminderEntry = StreamUnreadMessageReminderEvent["channels"][string];

/** Regular messages from others, newest first, up to the recipient's own latest one. */
export function countNewMessages(
  messages: ReminderEntry["messages"],
  recipientId: string,
): { count: number; capped: boolean } {
  let count = 0;
  for (const message of messages) {
    if (message.user?.id === recipientId) {
      return { count, capped: false };
    }
    if (message.type === "regular") count += 1;
  }
  return {
    count,
    capped: count > 0 && messages.length >= STREAM_MESSAGE_SAMPLE,
  };
}

interface CandidateThread {
  channelId: string;
  orgScoped: boolean;
  counterpartIds: string[];
  newMessages: number;
  capped: boolean;
}

function candidateThreads(
  event: StreamUnreadMessageReminderEvent,
): CandidateThread[] {
  const recipientId = event.user.id;
  return Object.values(event.channels).flatMap((entry) => {
    if (entry.channel.type !== "messaging") return [];
    const counterpartIds = [
      ...new Set(entry.channel.members.map((m) => m.user_id)),
    ].filter((id) => id !== recipientId && !isSupportStreamUser(id));
    const { count, capped } = countNewMessages(entry.messages, recipientId);
    if (counterpartIds.length === 0 || count === 0) return [];
    return [
      {
        channelId: entry.channel.id,
        orgScoped: entry.channel.id.startsWith(DM_ORG_PREFIX),
        counterpartIds,
        newMessages: count,
        capped,
      },
    ];
  });
}

/** The pair's next live session, else their latest past one. */
async function sessionContext(
  recipientId: string,
  counterpartId: string,
  orgScoped: boolean,
  now: Date,
): Promise<{ startsAt: Date; organizationId: string | null } | null> {
  const where = (startsAt: { gte: Date } | { lt: Date }) => ({
    deletedAt: null,
    isTentative: false,
    completionStatus: { notIn: ["CANCELLED" as const, "RESCHEDULED" as const] },
    startsAt,
    appointment: {
      deletedAt: null,
      organizationId: orgScoped ? { not: null } : null,
      AND: [
        { participants: { some: liveParticipant(recipientId) } },
        { participants: { some: liveParticipant(counterpartId) } },
      ],
    },
  });
  const select = {
    startsAt: true,
    appointment: { select: { organizationId: true } },
  } as const;
  const row =
    (await prisma.appointmentOccurrence.findFirst({
      where: where({ gte: now }),
      orderBy: { startsAt: "asc" },
      select,
    })) ??
    (await prisma.appointmentOccurrence.findFirst({
      where: where({ lt: now }),
      orderBy: { startsAt: "desc" },
      select,
    }));
  return row
    ? { startsAt: row.startsAt, organizationId: row.appointment.organizationId }
    : null;
}

function messagesHref(
  organizationId: string | null,
  channelId?: string,
): string {
  const base = organizationId
    ? `/dashboard/organization/${organizationId}/messages`
    : "/dashboard/go/auto/messages";
  const query = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
  return `${getAppUrl()}${base}${query}`;
}

async function buildThreads(
  recipientId: string,
  candidates: CandidateThread[],
  now: Date,
): Promise<{ threads: ChatDigestThread[]; organizationId: string | null }> {
  const counterparts = await prisma.user.findMany({
    where: {
      id: { in: [...new Set(candidates.flatMap((c) => c.counterpartIds))] },
      erasedAt: null,
    },
    select: { id: true, name: true },
  });
  const nameById = new Map(
    counterparts.map((u) => [u.id, u.name?.trim() || "your contact"]),
  );

  const threads: ChatDigestThread[] = [];
  let firstOrg: string | null = null;
  for (const candidate of candidates) {
    const live = candidate.counterpartIds.filter((id) => nameById.has(id));
    if (live.length === 0) continue;
    const session = await sessionContext(
      recipientId,
      live[0],
      candidate.orgScoped,
      now,
    );
    const organizationId = session?.organizationId ?? null;
    if (threads.length === 0) firstOrg = organizationId;
    threads.push({
      counterpartNames: live.map((id) => nameById.get(id) ?? "your contact"),
      newMessages: candidate.newMessages,
      capped: candidate.capped,
      sessionStartsAt: session?.startsAt ?? null,
      href: messagesHref(organizationId, candidate.channelId),
    });
  }
  return { threads, organizationId: firstOrg };
}

export async function handleUnreadMessageReminder(
  event: StreamUnreadMessageReminderEvent,
): Promise<void> {
  const recipientId = event.user.id;
  const createdAt = new Date(event.created_at);
  if (isSupportStreamUser(recipientId) || Number.isNaN(createdAt.getTime())) {
    return;
  }

  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { banned: true, erasedAt: true, timezone: true },
  });
  if (!recipient || recipient.banned || recipient.erasedAt) {
    streamLogger.debug("Chat digest skipped: recipient is not a live user", {
      recipientId,
    });
    return;
  }

  const candidates = candidateThreads(event);
  if (candidates.length === 0) return;
  const { threads, organizationId } = await buildThreads(
    recipientId,
    candidates,
    createdAt,
  );
  if (threads.length === 0) return;

  const windowStart = digestWindowStart(createdAt);
  const dedupeKey = chatDigestDedupeKey(recipientId, windowStart);
  const zone = resolveViewerZone({
    userTimezone: recipient.timezone,
    fallbackZone: DEFAULT_NOTIFICATION_TIMEZONE,
  });
  const first = chatDigestLine(threads[0], zone);
  const summary =
    threads.length === 1
      ? first
      : `${first} You have unread messages in ${threads.length - 1} more conversation${threads.length > 2 ? "s" : ""}.`;
  const prepared = await prepareChatUnreadDigestEmail({
    userId: recipientId,
    entityRef: dedupeKey,
    threads,
  });

  let bundle;
  try {
    bundle = await prisma.$transaction(async (tx) => {
      // The (scope, key, userId) unique makes a retried or re-driven reminder a no-op.
      await tx.idempotencyRecord.create({
        data: {
          scope: CHAT_DIGEST_SCOPE,
          key: windowStart.toISOString(),
          userId: recipientId,
          requestHash: dedupeKey,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        },
      });
      const bell = await stageBell(tx, {
        workflowId: NOVU_WORKFLOWS.CHAT_UNREAD_DIGEST,
        recipients: [recipientId],
        dedupeKey,
        entityRef: dedupeKey,
        deferrable: true,
        payload: {
          summary,
          threadCount: threads.length,
          dashboardUrl:
            threads.length === 1
              ? threads[0].href
              : messagesHref(organizationId),
          ...notificationScope(organizationId),
        },
      });
      const emails = await stagePreparedEmails(tx, prepared);
      return {
        bells: [bell],
        emails: [{ rows: emails, emailType: CHAT_UNREAD_DIGEST_EMAIL_TYPE }],
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      streamLogger.debug("Chat digest already staged for this window", {
        recipientId,
        windowStart: windowStart.toISOString(),
      });
      return;
    }
    throw error;
  }
  await flushNotificationsAfter(bundle, "stream.chat-digest");
}
