/**
 * Per-user list state for one conversation: pin it, unpin it, or hide it.
 *
 * It runs here rather than in the browser because Stream's grants for the `user`
 * role are deliberately narrow, and the gate has to live in our own layer: the
 * channel is found with the caller in `members`, so nobody can pin or hide a
 * conversation they are not in. Only the caller's own membership changes.
 *
 * Hiding keeps the history. Stream shows a hidden channel again on its next
 * message, and `/api/stream/channels/open` shows it when it is reopened.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";

import { requireApiAuth } from "@/lib/auth-helpers";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CHANNEL_ID_MAX } from "@/lib/stream-utils";
import { streamLogger } from "@/lib/stream-logger";

const bodySchema = z.object({
  channelType: z.enum(["messaging", "team"]),
  channelId: z.string().min(1).max(STREAM_CHANNEL_ID_MAX),
  action: z.enum(["pin", "unpin", "hide"]),
});

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
  const { channelType, channelId, action } = parsed.data;

  try {
    const [channel] = await withStreamCircuitBreaker(() =>
      getStreamChatClient().queryChannels(
        {
          type: channelType,
          id: { $eq: channelId },
          members: { $in: [userId] },
        },
        {},
        {
          limit: 1,
          state: true,
          watch: false,
          presence: false,
          message_limit: 0,
        },
      ),
    );
    if (!channel) {
      return NextResponse.json(
        { error: "Conversation not found." },
        { status: 404 },
      );
    }

    await withStreamCircuitBreaker(async () => {
      if (action === "pin") await channel.pin({ user_id: userId });
      else if (action === "unpin") await channel.unpin({ user_id: userId });
      else await channel.hide(userId, false);
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to update conversation preference", error, {
      userId,
      channelId,
      action,
    });
    return NextResponse.json(
      { error: "Could not update this conversation. Please try again." },
      { status: 500 },
    );
  }
}
