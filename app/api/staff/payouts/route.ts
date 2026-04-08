/**
 * Staff Payouts API
 * Staff access to payout management (same as admin)
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PayoutStatus } from "@prisma/client";
import { getPayoutStats } from "@/lib/payments/payouts";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
/**
 * GET /api/staff/payouts
 * Get payouts with optional status filter (staff access)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

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
      { status: 500 },
    );
  }
}
