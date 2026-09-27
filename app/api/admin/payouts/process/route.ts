/**
 * Admin Payout Processing API
 * Process all approved payouts
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import {
  processApprovedPayouts,
  REQUEST_PAYOUT_RUN_BOUNDS,
} from "@/lib/payments/payouts";
import { requireAdminAuth } from "@/lib/auth-helpers";

/**
 * POST /api/admin/payouts/process
 * Process all approved payouts
 */
export async function POST(_req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    // #1846 N6 — a request-bound run: no new payout after the budget and a
    // short lock, so a function killed at the Lambda limit cannot hold the
    // payout lock for 35 minutes. Unstarted payouts stay APPROVED.
    const results = await processApprovedPayouts(REQUEST_PAYOUT_RUN_BOUNDS);

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: true,
      processed: results.length,
      successful,
      failed,
      results,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error processing payouts:", error);
    return NextResponse.json(
      { error: "Failed to process payouts" },
      { status: 500 },
    );
  }
}
