/**
 * Mark overdue org invoices.
 *
 * Finds all SENT OrganizationInvoice rows whose dueDate has passed and
 * flips them to OVERDUE. Keeps the billing dashboard and invoice list
 * accurate without requiring manual admin intervention.
 *
 * Schedule: Daily at 01:00 UTC (via GitHub Actions or external cron).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handler(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handler(req);
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn("[Cron mark-overdue-invoices] Unauthorized attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();

    // Bulk-flip all SENT invoices past their dueDate in a single UPDATE.
    const result = await prisma.organizationInvoice.updateMany({
      where: {
        status: "SENT",
        dueDate: { lt: now },
      },
      data: { status: "OVERDUE" },
    });

    console.log(
      `[Cron mark-overdue-invoices] Marked ${result.count} invoice(s) as OVERDUE`,
    );

    return NextResponse.json({
      success: true,
      overdueCount: result.count,
      processedAt: now.toISOString(),
    });
  } catch (error) {
    console.error("[Cron mark-overdue-invoices] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to mark overdue invoices",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
