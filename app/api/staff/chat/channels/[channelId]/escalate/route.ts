/**
 * Staff Chat Channel Escalate API
 * Escalate a support chat to a formal support ticket
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

interface RouteParams {
  params: Promise<{ channelId: string }>;
}

/**
 * POST /api/staff/chat/channels/[channelId]/escalate
 * Create a support ticket from this channel
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
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
    const { title, description, priority, category, issueType } = body;

    // Get channel
    const channel = await prisma.staffSupportChannel.findUnique({
      where: { id: channelId },
      include: {
        customer: { select: { id: true, name: true } },
      },
    });

    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    if (channel.linkedTicketId) {
      return NextResponse.json(
        { error: "Channel already has a linked ticket" },
        { status: 400 }
      );
    }

    // Create ticket and link to channel in transaction
    const [ticket, updatedChannel] = await prisma.$transaction([
      prisma.supportTicket.create({
        data: {
          title: title || `Support request from ${channel.customer.name || "customer"}`,
          description: description || channel.topic || "Escalated from support chat",
          priority: priority || channel.priority,
          category,
          issueType,
          userId: channel.customerId,
          assignedToId: channel.assignedStaffId,
        },
      }),
      prisma.staffSupportChannel.update({
        where: { id: channelId },
        data: {
          linkedTicketId: "", // Will be updated after we get ticket ID
        },
      }),
    ]);

    // Update channel with actual ticket ID
    await prisma.staffSupportChannel.update({
      where: { id: channelId },
      data: { linkedTicketId: ticket.id },
    });

    return NextResponse.json({
      ticket: {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
      },
      message: "Chat escalated to support ticket",
    });
  } catch (error) {
    console.error("Error escalating channel:", error);
    return NextResponse.json(
      { error: "Failed to escalate channel" },
      { status: 500 }
    );
  }
}
