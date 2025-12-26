/**
 * Admin Earnings Stats API
 * Get earnings statistics for admin dashboard
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getEarningsStats } from "@/lib/payments/payouts/earnings-service";

/**
 * GET /api/admin/earnings/stats
 * Get earnings statistics
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check admin role
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const stats = await getEarningsStats();

    return NextResponse.json({ stats });
  } catch (error) {
    console.error("Error fetching earnings stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings stats" },
      { status: 500 }
    );
  }
}
