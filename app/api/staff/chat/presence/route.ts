/**
 * Staff Chat Presence API
 * Get and update staff availability status
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/chat/presence
 * Get staff presence/availability
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

    // Get all staff users with their online status
    const staffUsers = await prisma.user.findMany({
      where: { role: UserRole.STAFF },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        onlineStatus: true,
      },
    });

    // Get active channel counts per staff
    const activeCounts = await prisma.staffSupportChannel.groupBy({
      by: ["assignedStaffId"],
      where: {
        status: "ASSIGNED",
        assignedStaffId: { not: null },
      },
      _count: { id: true },
    });

    const activeMap = new Map(
      activeCounts.map((a) => [a.assignedStaffId, a._count.id])
    );

    const staffWithPresence = staffUsers.map((staff) => ({
      id: staff.id,
      name: staff.name,
      email: staff.email,
      image: staff.image,
      isOnline: staff.onlineStatus,
      activeChats: activeMap.get(staff.id) || 0,
    }));

    return NextResponse.json({
      staff: staffWithPresence,
      onlineCount: staffWithPresence.filter((s) => s.isOnline).length,
      totalStaff: staffWithPresence.length,
    });
  } catch (error) {
    console.error("Error fetching presence:", error);
    return NextResponse.json(
      { error: "Failed to fetch presence" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/staff/chat/presence
 * Update own presence status
 */
export async function PATCH(req: NextRequest) {
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
    const { online } = body;

    if (typeof online !== "boolean") {
      return NextResponse.json(
        { error: "online must be a boolean" },
        { status: 400 }
      );
    }

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: { onlineStatus: online },
      select: {
        id: true,
        name: true,
        onlineStatus: true,
      },
    });

    return NextResponse.json({
      user: updatedUser,
      message: online ? "Now online" : "Now offline",
    });
  } catch (error) {
    console.error("Error updating presence:", error);
    return NextResponse.json(
      { error: "Failed to update presence" },
      { status: 500 }
    );
  }
}
