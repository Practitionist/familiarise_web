/**
 * Consultant Earnings API
 * View earnings summary and history
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { EarningStatus } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  getConsultantEarningsSummary,
  getConsultantEarnings,
  checkPayoutEligibility,
} from "@/lib/payments/payouts";

/**
 * GET /api/consultant/earnings
 * Get consultant's earnings summary and history
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as EarningStatus | null;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Get earnings summary
    const summary = await getConsultantEarningsSummary(consultantProfile.id);

    // Get payout eligibility
    const eligibility = await checkPayoutEligibility(consultantProfile.id);

    // Get earnings history
    const { earnings, total, hasMore } = await getConsultantEarnings(
      consultantProfile.id,
      {
        status: status || undefined,
        limit,
        offset,
      },
    );

    return NextResponse.json({
      summary,
      eligibility,
      earnings,
      pagination: {
        total,
        limit,
        offset,
        hasMore,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultant" } });
    console.error("Error fetching earnings:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
