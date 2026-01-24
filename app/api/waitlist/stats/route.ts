/**
 * Waitlist Stats API
 * GET: Get waitlist statistics for a consultant
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getWaitlistStats } from "@/lib/waitlist";

/**
 * GET /api/waitlist/stats - Get consultant's waitlist statistics
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get consultant profile
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: {
        consultantProfile: true,
      },
    });

    if (!user?.consultantProfile) {
      return NextResponse.json(
        { success: false, error: "Consultant profile not found" },
        { status: 404 }
      );
    }

    const stats = await getWaitlistStats(user.consultantProfile.id);

    return NextResponse.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching waitlist stats:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch waitlist statistics" },
      { status: 500 }
    );
  }
}
