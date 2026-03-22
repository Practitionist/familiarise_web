import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import prisma from "@/lib/prisma";
import { getDmChannelId } from "@/lib/stream-utils";

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
    const chatClient = getStreamChatClient();
    const dmChannelId = getDmChannelId(session.user.id, targetUserId);
    const dmChannel = chatClient.channel("messaging", dmChannelId);
    try {
      const state = await dmChannel.query({ members: { limit: 0 } });
      if (!state.channel) {
        return NextResponse.json(
          { error: "You can only block users you have a conversation with" },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "You can only block users you have a conversation with" },
        { status: 403 },
      );
    }

    // Ban the user in this specific channel (scoped, not global)
    await dmChannel.banUser(targetUserId, {
      banned_by_id: session.user.id,
      reason: "user_block",
    });

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
    streamLogger.error("Failed to block user", error);
    return NextResponse.json(
      { error: "Failed to block user" },
      { status: 500 },
    );
  }
}
