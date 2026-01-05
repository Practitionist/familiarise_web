/**
 * Document Storage Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-document-storage.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcileDocumentStorage } from "@/scripts/cleanup/reconcile-document-storage";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized document storage reconciliation attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("📂 Starting document storage reconciliation via API...");

    const result = await reconcileDocumentStorage();

    console.log("✅ Document storage reconciliation completed:", {
      orphanedFilesFound: result.orphanedFilesFound,
      orphanedFilesDeleted: result.orphanedFilesDeleted,
      missingFilesFound: result.missingFilesFound,
    });

    // Return 207 if missing files found (needs attention)
    const status = result.missingFilesFound > 0 ? 207 : result.success ? 200 : 500;

    return NextResponse.json(result, { status });
  } catch (error) {
    console.error("Error in document storage reconciliation:", error);
    return NextResponse.json(
      {
        error: "Failed to reconcile document storage",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Also support POST for manual triggering
export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
