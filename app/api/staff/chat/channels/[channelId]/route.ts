/**
 * Staff Chat Channel Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole, SupportChannelStatus, SupportPriority } from "@prisma/client";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

/**
 * GET /api/staff/chat/channels/[channelId]
 * Get channel details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
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

    const { channelId } = await params;

    const channel = await prisma.staffSupportChannel.findUnique({
      where: { id: channelId },
      include: {
        customer: {
          select: { id: true, name: true, email: true, image: true, phone: true },
        },
        assignedStaff: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });

    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    // If there's a linked ticket, fetch it too
    let linkedTicket = null;
    if (channel.linkedTicketId) {
      linkedTicket = await prisma.supportTicket.findUnique({
        where: { id: channel.linkedTicketId },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
        },
      });
    }

    return NextResponse.json({
      channel: {
        ...channel,
        linkedTicket,
      },
    });
  } catch (error) {
    console.error("Error fetching channel:", error);
    return NextResponse.json(
      { error: "Failed to fetch channel" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/staff/chat/channels/[channelId]
 * Update channel (status, assignment, priority)
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
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

    const { channelId } = await params;
    const body = await req.json();
    const { status, assignedStaffId, priority } = body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};

    if (status !== undefined) {
      const validStatuses: SupportChannelStatus[] = [
        "OPEN",
        "ASSIGNED",
        "RESOLVED",
        "CLOSED",
      ];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      updateData.status = status;

      // Set timestamps based on status
      if (status === "RESOLVED") {
        updateData.resolvedAt = new Date();
      } else if (status === "CLOSED") {
        updateData.closedAt = new Date();
      }
    }

    if (assignedStaffId !== undefined) {
      updateData.assignedStaffId = assignedStaffId || null;
      if (assignedStaffId) {
        updateData.assignedAt = new Date();
        updateData.status = "ASSIGNED";
      }
    }

    if (priority !== undefined) {
      const validPriorities: SupportPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
      if (!validPriorities.includes(priority)) {
        return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
      }
      updateData.priority = priority;
    }

    const channel = await prisma.staffSupportChannel.update({
      where: { id: channelId },
      data: updateData,
      include: {
        customer: {
          select: { id: true, name: true, email: true },
        },
        assignedStaff: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return NextResponse.json({ channel });
  } catch (error) {
    console.error("Error updating channel:", error);
    return NextResponse.json(
      { error: "Failed to update channel" },
      { status: 500 }
    );
  }
}
