/**
 * Chat Moderation Webhook Handlers
 * Handles user.flagged and message.flagged events from Stream Chat
 * Creates ModerationReport records in our DB for staff review
 */

import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";

export interface StreamUserFlaggedEvent {
  type: "user.flagged";
  created_at: string;
  user?: { id: string };
  target_user?: { id: string };
}

export interface StreamMessageFlaggedEvent {
  type: "message.flagged";
  created_at: string;
  user?: { id: string };
  message?: {
    id: string;
    text?: string;
    user?: { id: string };
  };
}

/**
 * Handle user.flagged webhook event
 * Creates or increments a ModerationReport with type PROFILE
 */
export async function handleUserFlagged(
  event: StreamUserFlaggedEvent,
): Promise<void> {
  const flaggerId = event.user?.id;
  const targetUserId = event.target_user?.id;

  if (!targetUserId) {
    streamLogger.warn("user.flagged event missing target_user", {
      eventType: event.type,
    });
    return;
  }

  try {
    // Check for existing pending report from same flagger
    const existing = flaggerId
      ? await prisma.moderationReport.findFirst({
          where: {
            reportedById: flaggerId,
            targetUserId,
            type: "PROFILE",
            status: { in: ["PENDING", "UNDER_REVIEW"] },
          },
        })
      : null;

    if (existing) {
      // Increment report count
      await prisma.moderationReport.update({
        where: { id: existing.id },
        data: { reportCount: { increment: 1 } },
      });
      streamLogger.info("User flag report incremented", {
        reportId: existing.id,
        targetUserId,
      });
    } else if (flaggerId) {
      // Create new report (requires a reporter)
      await prisma.moderationReport.create({
        data: {
          type: "PROFILE",
          reason: "User flagged via Stream webhook",
          description: `User flagged at ${event.created_at}`,
          reportedById: flaggerId,
          targetUserId,
        },
      });
      streamLogger.info("User flag report created", { targetUserId });
    } else {
      streamLogger.warn("user.flagged event missing flagger, skipping DB report", {
        targetUserId,
      });
    }
  } catch (error) {
    streamLogger.error("Failed to process user.flagged event", error, {
      targetUserId,
    });
    throw error;
  }
}

/**
 * Handle message.flagged webhook event
 * Creates or increments a ModerationReport with type MESSAGE
 */
export async function handleMessageFlagged(
  event: StreamMessageFlaggedEvent,
): Promise<void> {
  const flaggerId = event.user?.id;
  const messageAuthorId = event.message?.user?.id;
  const messageText = event.message?.text?.substring(0, 500);

  if (!messageAuthorId) {
    streamLogger.warn("message.flagged event missing message author", {
      eventType: event.type,
    });
    return;
  }

  try {
    // Check for existing pending report for same message author
    const existing = flaggerId
      ? await prisma.moderationReport.findFirst({
          where: {
            reportedById: flaggerId,
            targetUserId: messageAuthorId,
            type: "MESSAGE",
            status: { in: ["PENDING", "UNDER_REVIEW"] },
          },
        })
      : null;

    if (existing) {
      await prisma.moderationReport.update({
        where: { id: existing.id },
        data: { reportCount: { increment: 1 } },
      });
      streamLogger.info("Message flag report incremented", {
        reportId: existing.id,
        targetUserId: messageAuthorId,
      });
    } else if (flaggerId) {
      await prisma.moderationReport.create({
        data: {
          type: "MESSAGE",
          reason: "Message flagged via Stream webhook",
          description: `Message flagged at ${event.created_at}`,
          contentText: messageText,
          reportedById: flaggerId,
          targetUserId: messageAuthorId,
        },
      });
      streamLogger.info("Message flag report created", {
        targetUserId: messageAuthorId,
      });
    } else {
      streamLogger.warn("message.flagged event missing flagger, skipping DB report", {
        messageAuthorId,
      });
    }
  } catch (error) {
    streamLogger.error("Failed to process message.flagged event", error, {
      messageAuthorId,
    });
    throw error;
  }
}
