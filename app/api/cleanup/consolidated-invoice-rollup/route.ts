/**
 * POST /api/cleanup/consolidated-invoice-rollup
 *
 * HTTP companion to `jobs/cleanup/consolidated-invoice-rollup.ts`. Lets
 * an operator run the monthly rollup on-demand for a parent org that
 * was onboarded mid-cycle and needs to catch up. Gated by the same
 * `ENABLE_CONSOLIDATED_INVOICE` env flag as the cron — an off-flag
 * response still returns 200 with `{enabled: false, skipped: true}`
 * so scripts can distinguish "flag off" from "flag on, nothing to do".
 *
 * Auth: `CRON_SECRET` bearer, matching every other `/api/cleanup/*`
 * endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runConsolidatedInvoiceRollup } from "@/scripts/cleanup/consolidated-invoice-rollup";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn("Unauthorized consolidated-invoice-rollup attempt");
    return NextResponse.json(
      {
        error: "Unauthorized",
        message:
          "Please provide a valid authorization header with the CRON_SECRET",
      },
      { status: 401 },
    );
  }

  try {
    const result = await runConsolidatedInvoiceRollup();

    console.log("✅ Consolidated-invoice rollup completed:", {
      enabled: result.enabled,
      parentsRolled: result.parentsRolled,
      childInvoicesRolled: result.childInvoicesRolled,
      success: result.success,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("[cleanup/consolidated-invoice-rollup] failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Some external schedulers (e.g. legacy Vercel Cron) only emit GET.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
