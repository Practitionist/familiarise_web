/**
 * POST /api/cleanup/prune-audit-logs
 *
 * HTTP shim. CRON_SECRET-gated like every other cleanup route.
 */

import { NextResponse, type NextRequest } from "next/server";
import { pruneAuditLogs } from "@/scripts/cleanup/prune-audit-logs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await pruneAuditLogs();
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Audit prune failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
