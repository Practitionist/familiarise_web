/**
 * Staff Reports Categories API
 * Ticket breakdown by category/issue type
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/reports/categories
 * Get ticket distribution by category
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get("days") || "30");

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Group by issue type
    const issueTypeCounts = await prisma.supportTicket.groupBy({
      by: ["issueType"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    // Group by category
    const categoryCounts = await prisma.supportTicket.groupBy({
      by: ["category"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    const total = issueTypeCounts.reduce(
      (sum, item) => sum + item._count.id,
      0
    );

    // Format issue types
    const byIssueType = issueTypeCounts
      .filter((item) => item.issueType)
      .map((item) => ({
        issueType: item.issueType,
        displayName: formatIssueType(item.issueType!),
        count: item._count.id,
        percentage: total > 0 ? Math.round((item._count.id / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // Format categories
    const byCategory = categoryCounts
      .filter((item) => item.category)
      .map((item) => ({
        category: item.category,
        count: item._count.id,
        percentage: total > 0 ? Math.round((item._count.id / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return NextResponse.json({
      byIssueType,
      byCategory,
      total,
      period: { days, startDate, endDate: new Date() },
    });
  } catch (error) {
    console.error("Error fetching category reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch category reports" },
      { status: 500 }
    );
  }
}

function formatIssueType(issueType: string): string {
  const mapping: Record<string, string> = {
    CONSULTANT_NO_SHOW: "Consultant No-Show",
    CONSULTANT_LATE: "Consultant Late",
    SESSION_ENDED_EARLY: "Session Ended Early",
    SESSION_QUALITY_POOR: "Poor Session Quality",
    COMMUNICATION_ISSUE: "Communication Issue",
    TECHNICAL_ISSUES: "Technical Issues",
    WRONG_CONSULTANT: "Wrong Consultant",
    ACCESS_ISSUE: "Access Issue",
    TIMEZONE_CONFUSION: "Timezone Confusion",
    RESCHEDULING_HELP: "Rescheduling Help",
    PAYMENT_FAILED: "Payment Failed",
    CHARGED_TWICE: "Charged Twice",
    REFUND_REQUEST: "Refund Request",
    BILLING_QUESTION: "Billing Question",
    DOCUMENT_ISSUE: "Document Issue",
    WANT_TO_CANCEL: "Want to Cancel",
    CANCELLATION_ISSUE: "Cancellation Issue",
    ACCOUNT_ISSUE: "Account Issue",
    GENERAL_INQUIRY: "General Inquiry",
    OTHER: "Other",
  };
  return mapping[issueType] || issueType;
}
