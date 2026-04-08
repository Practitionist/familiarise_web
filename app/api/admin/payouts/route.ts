/**
 * Admin Payouts API
 * Manage consultant payouts (view, approve, reject)
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { PayoutStatus, Prisma } from "@prisma/client";
import { getPayoutStats, createPayoutBatch } from "@/lib/payments/payouts";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

/**
 * GET /api/admin/payouts
 * Get payouts with optional status filter
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as PayoutStatus | null;
    const search = searchParams.get("search");
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build where clause with optional status and search filters
    const where: Prisma.PayoutWhereInput = {};
    if (status) {
      where.status = status;
    }
    if (search) {
      where.consultantProfile = {
        user: {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        },
      };
    }

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

/**
 * POST /api/admin/payouts
 * Create a new payout batch
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

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
    const classified = classifyError(error, "Failed to create payout batch");
    logClassifiedError("Payouts", classified, error);

    return NextResponse.json(
      { error: classified.errorMessage },
      { status: classified.httpStatus },
    );
  }
}
