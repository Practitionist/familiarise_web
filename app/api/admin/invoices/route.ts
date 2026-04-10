/**
 * Admin Invoices API
 * View all platform invoices.
 *
 * Thin shell — query/response logic lives in `lib/api/operators/invoices.ts`
 * and is shared with `/api/staff/invoices`.
 */

import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getOperatorInvoices } from "@/lib/api/operators";

/**
 * GET /api/admin/invoices
 * Get all invoices with optional filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getOperatorInvoices({
      status: searchParams.get("status") as PaymentStatus | null,
      search: searchParams.get("search"),
      limit: parseInt(searchParams.get("limit") || "20"),
      offset: parseInt(searchParams.get("offset") || "0"),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return NextResponse.json(
      { error: "Failed to fetch invoices" },
      { status: 500 },
    );
  }
}
