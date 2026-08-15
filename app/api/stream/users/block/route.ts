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

    // `limit: 30` is Stream's real per-call cap for queryChannels regardless of
    // what you pass, and it is not a constraint here: the filter matches
    // channels whose membership is EXACTLY this pair, which is one personal
    // thread plus at most one per organization, and `lib/auth.ts` caps a user at
    // `organizationLimit: 5`. Six is the ceiling. No pagination needed.
    let dmChannels: Awaited<ReturnType<typeof chatClient.queryChannels>>;
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
      // 5xx, NOT the 403 below. An earlier version assigned `[]` here and fell
      // through, so a Stream outage told two people mid-conversation that they
      // "can only block users you have a conversation with" — an infrastructure
      // failure reported as a policy decision, and the one moment when someone
      // reaching for the block button most needs it to work.
      Sentry.captureException(
        queryError instanceof Error ? queryError : new Error(String(queryError)),
        { tags: { subsystem: "stream" } },
      );
      streamLogger.error("Block: DM channel lookup failed", queryError, {
        userId: session.user.id,
        targetUserId,
      });
      return NextResponse.json(
        { error: "Could not block this user right now. Please try again." },
        { status: 503 },
      );
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
    //
    // `allSettled`, not a sequential loop: the loop aborted on the first
    // rejection, so a transient failure on the personal thread left the org
    // thread unbanned AND skipped the moderation report — the worst of the three
    // possible outcomes. Now every channel is attempted, and the block stands as
    // long as one succeeded.
    const banResults = await Promise.allSettled(
      dmChannels.map((dmChannel) =>
        dmChannel.banUser(targetUserId, {
          banned_by_id: session.user.id,
          reason: "user_block",
        }),
      ),
    );

    const failures = banResults.filter((r) => r.status === "rejected");
    if (failures.length === dmChannels.length) {
      Sentry.captureException(new Error("Block: every channel ban failed"), {
        tags: { subsystem: "stream" },
      });
      streamLogger.error("Block: every channel ban failed", failures[0], {
        userId: session.user.id,
        targetUserId,
        channelCount: dmChannels.length,
      });
      return NextResponse.json(
        { error: "Could not block this user right now. Please try again." },
        { status: 503 },
      );
    }
    if (failures.length > 0) {
      // Partial success still blocks — but it leaves a writable thread behind,
      // so it must be visible rather than inferred from a quiet log.
      Sentry.captureException(
        new Error("Block: some channel bans failed"),
        { tags: { subsystem: "stream" } },
      );
      streamLogger.warn("Block: some channel bans failed", {
        userId: session.user.id,
        targetUserId,
        failed: failures.length,
        total: dmChannels.length,
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
