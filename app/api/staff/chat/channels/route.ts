/**
 * Staff Chat Channels API
 * List and create support chat channels
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, SupportChannelStatus, SupportPriority } from "@prisma/client";

/**
 * GET /api/staff/chat/channels
 * List support chat channels
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
    const status = searchParams.get("status") as SupportChannelStatus | null;
    const assignedToMe = searchParams.get("assignedToMe") === "true";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (status) where.status = status;
    if (assignedToMe) where.assignedStaffId = session.user.id;

    const [channels, total] = await Promise.all([
      prisma.staffSupportChannel.findMany({
        where,
        include: {
          customer: {
            select: { id: true, name: true, email: true, image: true },
          },
          assignedStaff: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
        orderBy: [
          { priority: "desc" }, // Higher priority first
          { createdAt: "desc" },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.staffSupportChannel.count({ where }),
    ]);

    const formattedChannels = channels.map((channel) => ({
      id: channel.id,
      streamChannelId: channel.streamChannelId,
      status: channel.status,
      topic: channel.topic,
      priority: channel.priority,
      customer: channel.customer,
      assignedStaff: channel.assignedStaff,
      linkedTicketId: channel.linkedTicketId,
      createdAt: channel.createdAt,
      assignedAt: channel.assignedAt,
      resolvedAt: channel.resolvedAt,
    }));

    // Get counts by status
    const statusCounts = await prisma.staffSupportChannel.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const counts = {
      total,
      open: statusCounts.find((s) => s.status === "OPEN")?._count.id || 0,
      assigned:
        statusCounts.find((s) => s.status === "ASSIGNED")?._count.id || 0,
      resolved:
        statusCounts.find((s) => s.status === "RESOLVED")?._count.id || 0,
      closed: statusCounts.find((s) => s.status === "CLOSED")?._count.id || 0,
    };

    return NextResponse.json({
      channels: formattedChannels,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching chat channels:", error);
    return NextResponse.json(
      { error: "Failed to fetch channels" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/staff/chat/channels
 * Create a new support channel for a customer
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    // Allow staff/admin or the customer themselves
    const body = await req.json();
    const { customerId, topic, priority } = body;

    const targetCustomerId = customerId || session.user.id;

    // If creating for another user, must be staff/admin
    if (
      customerId &&
      customerId !== session.user.id &&
      user?.role !== UserRole.STAFF &&
      user?.role !== UserRole.ADMIN
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Generate unique Stream channel ID
    const streamChannelId = `support-${targetCustomerId}-${Date.now()}`;

    // Create channel record in DB
    const channel = await prisma.staffSupportChannel.create({
      data: {
        streamChannelId,
        customerId: targetCustomerId,
        topic,
        priority: priority || SupportPriority.MEDIUM,
        status: "OPEN",
      },
      include: {
        customer: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });

    // TODO: Create the actual Stream channel using Stream SDK
    // This would typically be done in a server action or service

    return NextResponse.json(
      {
        channel,
        message: "Support channel created",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating chat channel:", error);
    return NextResponse.json(
      { error: "Failed to create channel" },
      { status: 500 }
    );
  }
}
