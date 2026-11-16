/**
 * Stream Debug API Route
 *
 * Provides diagnostic information about Stream Chat state for a user.
 * SECURED: staff or admin session, and only served under `next dev`.
 *
 * Usage: GET /api/stream/debug?userId=USER_ID
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getStreamChatClient, isStreamConfigured } from "@/lib/stream-client";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { streamLogger } from "@/lib/stream-logger";
import prisma from "@/lib/prisma";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";

export async function GET(req: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPrivileged(session.user.role)) {
    streamLogger.warn("Non-privileged Stream debug attempt", {
      userId: session.user.id,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!isDev) {
    return NextResponse.json(
      { error: "Debug endpoint not available in production" },
      { status: 403 },
    );
  }

  try {
    if (!isStreamConfigured()) {
      return NextResponse.json(
        { error: "Stream API keys not configured" },
        { status: 500 },
      );
    }

    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId query parameter is required" },
        { status: 400 },
      );
    }

    // Get user details from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: isDev, // Only include email in dev
        role: true,
        consultantProfileId: true,
        consulteeProfileId: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found in database" },
        { status: 404 },
      );
    }

    const serverClient = getStreamChatClient();

    // Get channels for the user
    const channels = await serverClient.queryChannels(
      { members: { $in: [userId] } },
      { last_message_at: -1 },
      { limit: 30 },
    );

    // Get event counts (simplified queries for performance)
    const eventCounts = await Promise.all([
      user.consultantProfileId
        ? prisma.consultation.count({
            where: {
              consultationPlan: {
                consultantProfileId: user.consultantProfileId,
              },
              status: "APPROVED",
            },
          })
        : user.consulteeProfileId
          ? prisma.consultation.count({
              where: {
                requestedById: user.consulteeProfileId,
                status: "APPROVED",
              },
            })
          : 0,
      user.consultantProfileId
        ? prisma.subscription.count({
            where: {
              subscriptionPlan: {
                consultantProfileId: user.consultantProfileId,
              },
              status: "APPROVED",
            },
          })
        : user.consulteeProfileId
          ? prisma.subscription.count({
              where: {
                requestedById: user.consulteeProfileId,
                status: "APPROVED",
              },
            })
          : 0,
      user.consultantProfileId
        ? prisma.webinar.count({
            where: {
              webinarPlan: { consultantProfileId: user.consultantProfileId },
            },
          })
        : prisma.webinar.count({
            where: {
              appointment: {
                participants: {
                  some: { ...liveParticipant(userId), ...NOT_COLLABORATOR_ROW },
                },
              },
            },
          }),
      user.consultantProfileId
        ? prisma.class.count({
            where: {
              classPlan: { consultantProfileId: user.consultantProfileId },
            },
          })
        : prisma.class.count({
            where: {
              appointment: {
                participants: {
                  some: { ...liveParticipant(userId), ...NOT_COLLABORATOR_ROW },
                },
              },
            },
          }),
    ]);

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        isConsultant: !!user.consultantProfileId,
        isConsultee: !!user.consulteeProfileId,
      },
      stream: {
        channelCount: channels.length,
        channels: channels.map((channel) => ({
          id: channel.id,
          type: channel.type,
          name: channel.data?.name,
          memberCount: Object.keys(channel.state.members || {}).length,
          messageCount: channel.state.messages.length,
        })),
      },
      database: {
        consultations: eventCounts[0],
        subscriptions: eventCounts[1],
        webinars: eventCounts[2],
        classes: eventCounts[3],
      },
      // Include additional details only in development
      ...(isDev && {
        debug: {
          timestamp: new Date().toISOString(),
          nodeEnv: process.env.NODE_ENV,
        },
      }),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Debug endpoint error", error);
    return NextResponse.json(
      {
        error: "Debug request failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
