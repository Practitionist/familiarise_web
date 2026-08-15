import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { targetUserId } = body;

    if (!targetUserId || typeof targetUserId !== "string") {
      return NextResponse.json(
        { error: "targetUserId is required" },
        { status: 400 },
      );
    }

    if (targetUserId === session.user.id) {
      return NextResponse.json(
        { error: "You cannot block yourself" },
        { status: 400 },
      );
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 },
      );
    }

    // Verify the blocker has an existing DM channel with the target
    // (prevents arbitrary users from banning others they've never interacted with)
    //
    // Found by QUERY, not by deriving one id. This used to call
    // `getDmChannelId(me, target)` with no org argument, which only ever names
    // the PERSONAL `dm-` channel — so a pair whose conversation lives in an
    // org context (`dmo-…`) had no such channel, the existence probe threw, and
    // blocking answered 403 "you can only block users you have a conversation
    // with" to two people mid-conversation.
    //
    // `members: { $eq: [a, b] }` is Stream's documented way to find a 1:1: it
    // matches channels whose membership is exactly that pair, order-independent,
    // which catches all three id forms (`dm-`, `dmo-`, `dmh-`) without this
    // route having to know they exist.
    const chatClient = getStreamChatClient();
    let dmChannels: Awaited<ReturnType<typeof chatClient.queryChannels>> = [];
    try {
      dmChannels = await chatClient.queryChannels(
        {
          type: "messaging",
          members: { $eq: [session.user.id, targetUserId] },
        },
        { last_message_at: -1 },
        { limit: 30 },
      );
    } catch (queryError) {
      streamLogger.error("Block: DM channel lookup failed", queryError, {
        userId: session.user.id,
        targetUserId,
      });
      dmChannels = [];
    }

    if (dmChannels.length === 0) {
      return NextResponse.json(
        { error: "You can only block users you have a conversation with" },
        { status: 403 },
      );
    }

    // Ban in every shared DM, not just the one they happen to be looking at.
    // A block is about the person; leaving their org thread writable while the
    // personal one is banned would be a block that does not block.
    for (const dmChannel of dmChannels) {
      await dmChannel.banUser(targetUserId, {
        banned_by_id: session.user.id,
        reason: "user_block",
      });
    }

    // Create a moderation report in our DB
    await prisma.moderationReport.create({
      data: {
        type: "OTHER",
        reason: "User blocked via chat",
        description: `User ${session.user.id} blocked user ${targetUserId} from chat`,
        reportedById: session.user.id,
        targetUserId,
      },
    });

    streamLogger.info("User blocked", {
      blockedBy: session.user.id,
      targetUserId,
    });

    return NextResponse.json({
      success: true,
      message: "User blocked successfully",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    streamLogger.error("Failed to block user", error);
    return NextResponse.json(
      { error: "Failed to block user" },
      { status: 500 },
    );
  }
}
