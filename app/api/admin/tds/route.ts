/**
 * Admin TDS API
 * View TDS deduction summaries and manage Form 26Q filing status
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  getTDSSummary,
  getConsultantTDSBreakdown,
  markTDSAsFiled,
  getIndianFinancialYear,
} from "@/lib/payments/tax/tds-service";

/**
 * GET /api/admin/tds?fy=2026-27&view=summary|consultants
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== "ADMIN" && user?.role !== "STAFF") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const fy = searchParams.get("fy") || getIndianFinancialYear();
    const view = searchParams.get("view") || "summary";

    if (view === "consultants") {
      const breakdown = await getConsultantTDSBreakdown(fy);
      return NextResponse.json({ financialYear: fy, consultants: breakdown });
    }

    const summary = await getTDSSummary(fy);
    return NextResponse.json(summary);
  } catch (error) {
    console.error("Admin TDS API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch TDS data" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/admin/tds
 * Mark TDS records as filed in Form 26Q
 * Body: { financialYear: string, quarter: number, filingDate: string }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { financialYear, quarter, filingDate } = body;

    if (!financialYear || !quarter || !filingDate) {
      return NextResponse.json(
        { error: "financialYear, quarter, and filingDate are required" },
        { status: 400 },
      );
    }

    if (quarter < 1 || quarter > 4) {
      return NextResponse.json(
        { error: "quarter must be 1-4" },
        { status: 400 },
      );
    }

    const result = await markTDSAsFiled({
      financialYear,
      quarter,
      filingDate: new Date(filingDate),
    });

    return NextResponse.json({
      message: `Marked ${result.count} TDS records as filed`,
      financialYear,
      quarter,
      recordsUpdated: result.count,
    });
  } catch (error) {
    console.error("Admin TDS filing error:", error);
    return NextResponse.json(
      { error: "Failed to update TDS filing status" },
      { status: 500 },
    );
  }
}
