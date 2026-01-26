/**
 * Invoice API
 * Get user's invoices
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { PaymentStatus } from "@prisma/client";
import { getUserInvoices } from "@/lib/payments/payouts";

/**
 * GET /api/invoices
 * Get current user's invoices
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") as PaymentStatus | null;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    const { invoices, total, hasMore } = await getUserInvoices(
      session.user.id,
      {
        status: status || undefined,
        limit,
        offset,
      },
    );

    return NextResponse.json({
      invoices,
      pagination: {
        total,
        limit,
        offset,
        hasMore,
      },
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 },
    );
  }
}
