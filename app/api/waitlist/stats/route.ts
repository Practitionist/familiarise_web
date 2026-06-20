/**
 * Waitlist Stats API
 * GET: Get waitlist statistics for a consultant
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getWaitlistStats } from "@/lib/waitlist";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
/**
 * GET /api/waitlist/stats - Get consultant's waitlist statistics
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
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
        { status: 404 },
      );
    }

    const stats = await getWaitlistStats(user.consultantProfile.id);

    return NextResponse.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "waitlist" } });
    console.error("Error fetching waitlist stats:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch waitlist statistics" },
      { status: 500 },
    );
  }
}
