/**
 * Staff Chat Claim API
 * Claim a channel from the queue
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * POST /api/staff/chat/claim
 * Claim an unassigned channel
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

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { channelId } = body;

    if (!channelId) {
      return NextResponse.json(
        { error: "channelId is required" },
        { status: 400 }
      );
    }

    // Use transaction to prevent race conditions
    const channel = await prisma.$transaction(async (tx) => {
      // Check channel is still available
      const existing = await tx.staffSupportChannel.findUnique({
        where: { id: channelId },
        select: { status: true, assignedStaffId: true },
      });

      if (!existing) {
        throw new Error("Channel not found");
      }

      if (existing.assignedStaffId) {
        throw new Error("Channel already assigned");
      }

      if (existing.status !== "OPEN") {
        throw new Error("Channel is not open for claiming");
      }

      // Claim the channel
      return tx.staffSupportChannel.update({
        where: { id: channelId },
        data: {
          assignedStaffId: session.user!.id,
          status: "ASSIGNED",
          assignedAt: new Date(),
        },
        include: {
          customer: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      });
    });

    // TODO: Update Stream channel metadata with assigned staff

    return NextResponse.json({
      channel,
      message: "Channel claimed successfully",
    });
  } catch (error) {
    console.error("Error claiming channel:", error);

    if (error instanceof Error) {
      if (
        error.message === "Channel not found" ||
        error.message === "Channel already assigned" ||
        error.message === "Channel is not open for claiming"
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    return NextResponse.json(
      { error: "Failed to claim channel" },
      { status: 500 }
    );
  }
}
