/**
 * Admin Earnings API
 * View all consultant earnings
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { EarningStatus } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/admin/earnings
 * Get all earnings with optional status filter
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
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

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const validStatuses = Object.values(EarningStatus);
    const status =
      statusParam && validStatuses.includes(statusParam as EarningStatus)
        ? (statusParam as EarningStatus)
        : null;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build where clause
    const where = status ? { status } : {};

    // Get earnings
    const [earnings, total] = await Promise.all([
      prisma.consultantEarnings.findMany({
        where,
        include: {
          consultantProfile: {
            include: {
              user: { select: { name: true, email: true } },
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
            },
          },
          payout: {
            select: {
              id: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.consultantEarnings.count({ where }),
    ]);

    return NextResponse.json({
      earnings,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching earnings:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
