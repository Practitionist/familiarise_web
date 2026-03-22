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

    // Ban the user in Stream Chat (server-side only)
    const chatClient = getStreamChatClient();
    await chatClient.banUser(targetUserId, {
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
