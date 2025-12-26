/**
 * Admin Payouts API
 * Manage consultant payouts (view, approve, reject)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { PayoutStatus } from "@prisma/client";
import { getPayoutStats, createPayoutBatch } from "@/lib/payments/payouts";

/**
 * GET /api/admin/payouts
 * Get payouts with optional status filter
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

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as PayoutStatus | null;
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build where clause
    const where = status ? { status } : {};

    // Get payouts
    const [payouts, total] = await Promise.all([
      prisma.payout.findMany({
        where,
        include: {
          consultantProfile: {
            include: {
              user: { select: { name: true, email: true } },
            },
          },
          earnings: {
            select: { id: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.payout.count({ where }),
    ]);

    // Get stats
    const stats = await getPayoutStats();

    return NextResponse.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        consultantProfileId: p.consultantProfileId,
        consultantName: p.consultantProfile.user.name || "Unknown",
        consultantEmail: p.consultantProfile.user.email,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        method: p.method,
        provider: p.provider,
        batchId: p.batchId,
        earningsCount: p.earnings.length,
        approvedAt: p.approvedAt,
        approvedBy: p.approvedBy,
        processedAt: p.processedAt,
        failureReason: p.failureReason,
        createdAt: p.createdAt,
      })),
      stats,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching payouts:", error);
    return NextResponse.json(
      { error: "Failed to fetch payouts" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/payouts
 * Create a new payout batch
 */
export async function POST(req: NextRequest) {
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

    const body = await req.json();
    const { consultantProfileIds } = body;

    // Create payout batch
    const batchId = await createPayoutBatch(consultantProfileIds);

    // Get created payouts
    const payouts = await prisma.payout.findMany({
      where: { batchId },
      include: {
        consultantProfile: {
          include: {
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      batchId,
      payoutsCreated: payouts.length,
      payouts: payouts.map((p) => ({
        id: p.id,
        consultantName: p.consultantProfile.user.name,
        amount: p.amount,
        status: p.status,
      })),
    });
  } catch (error) {
    console.error("Error creating payout batch:", error);
    return NextResponse.json(
      { error: "Failed to create payout batch" },
      { status: 500 }
    );
  }
}
