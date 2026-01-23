/**
 * Staff Chat Queue API
 * Get unassigned channels waiting in queue
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/chat/queue
 * Get unassigned support channels
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "20");

    // Get unassigned, open channels
    const channels = await prisma.staffSupportChannel.findMany({
      where: {
        status: "OPEN",
        assignedStaffId: null,
      },
      include: {
        customer: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [
        { priority: "desc" }, // Urgent first
        { createdAt: "asc" }, // Oldest first (FIFO)
      ],
      take: limit,
    });

    const formattedChannels = channels.map((channel) => ({
      id: channel.id,
      streamChannelId: channel.streamChannelId,
      topic: channel.topic,
      priority: channel.priority,
      customer: channel.customer,
      waitTime: Date.now() - channel.createdAt.getTime(), // ms since created
      createdAt: channel.createdAt,
    }));

    // Get queue stats
    const [totalInQueue, urgentCount] = await Promise.all([
      prisma.staffSupportChannel.count({
        where: { status: "OPEN", assignedStaffId: null },
      }),
      prisma.staffSupportChannel.count({
        where: { status: "OPEN", assignedStaffId: null, priority: "URGENT" },
      }),
    ]);

    // Calculate average wait time
    const oldestChannel = await prisma.staffSupportChannel.findFirst({
      where: { status: "OPEN", assignedStaffId: null },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });

    const avgWaitTimeMs = oldestChannel
      ? Date.now() - oldestChannel.createdAt.getTime()
      : 0;

    return NextResponse.json({
      channels: formattedChannels,
      stats: {
        totalInQueue,
        urgentCount,
        avgWaitTimeMs,
        avgWaitTimeMinutes: Math.round(avgWaitTimeMs / (1000 * 60)),
      },
    });
  } catch (error) {
    console.error("Error fetching chat queue:", error);
    return NextResponse.json(
      { error: "Failed to fetch queue" },
      { status: 500 }
    );
  }
}
