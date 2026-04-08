/**
 * Admin TDS API
 * View TDS deduction summaries and manage Form 26Q filing status
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
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
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { searchParams } = new URL(req.url);
    const fy = searchParams.get("fy") || getIndianFinancialYear();
    const view = searchParams.get("view") || "summary";

    if (view === "consultants") {
      const breakdown = await getConsultantTDSBreakdown(fy);
      return NextResponse.json({ financialYear: fy, consultants: breakdown });
    }

    // Form 26Q filing view — ADMIN only (exposes decrypted PAN)
    if (view === "form26q") {
      if (session.user.role !== "ADMIN") {
        return NextResponse.json(
          { error: "Forbidden — Admin only for PAN access" },
          { status: 403 },
        );
      }

      const records = await prisma.tDSRecord.findMany({
        where: { financialYear: fy, reportedInForm26Q: false },
        include: {
          consultantProfile: {
            include: { taxInfo: true },
          },
        },
      });

      const { decryptPAN } = await import("@/lib/payments/tax/pan-crypto");
      const form26qData = records.map((r) => ({
        id: r.id,
        consultantProfileId: r.consultantProfileId,
        financialYear: r.financialYear,
        quarter: r.quarter,
        tdsDeducted: r.tdsDeducted,
        tdsRate: r.tdsRate,
        cumulativeAmountCredited: r.cumulativeAmountCredited,
        isReversal: r.isReversal,
        consultantPAN: r.consultantProfile.taxInfo?.panEncrypted
          ? decryptPAN(Buffer.from(r.consultantProfile.taxInfo.panEncrypted))
          : null,
        createdAt: r.createdAt,
      }));

      return NextResponse.json({ financialYear: fy, records: form26qData });
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
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

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
