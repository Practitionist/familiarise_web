/**
 * Admin Org Payout Processing
 *
 * POST /api/admin/org-payouts/process
 *
 * Processes all PENDING organization payouts via their configured payment gateway.
 * Admin-only endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { processOrgPayout } from "@/lib/payments/payouts/org-payout-service";
import { PayoutStatus } from "@prisma/client";

export async function POST(_req: NextRequest) {
  if (!ENABLE_PROVIDER_ORGS) {
    return NextResponse.json(
      { error: "PROVIDER orgs not enabled.", flag: "ENABLE_PROVIDER_ORGS" },
      { status: 501 },
    );
  }

  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const pendingPayouts = await prisma.organizationPayout.findMany({
    where: { status: PayoutStatus.PENDING },
    orderBy: { createdAt: "asc" },
  });

  if (pendingPayouts.length === 0) {
    return NextResponse.json({
      success: true,
      processed: 0,
      message: "No pending org payouts to process.",
    });
  }

  const results: Array<{
    payoutId: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const payout of pendingPayouts) {
    try {
      await processOrgPayout(payout.id);
      results.push({ payoutId: payout.id, success: true });
    } catch (error) {
      results.push({
        payoutId: payout.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return NextResponse.json({
    success: true,
    processed: results.length,
    successful,
    failed,
    results,
  });
}
