/**
 * Staff Appointments API
 * Staff/Admin access to all appointments with filtering and pagination.
 *
 * Thin shell — the JSON-safe read lives in `lib/data/staff-appointments.ts`
 * (`getStaffAppointments`), shared with the server prefetch (#890) so SSR
 * hydration and the client fetch resolve identical payloads.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getStaffAppointments } from "@/lib/data/staff-appointments";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getStaffAppointments({
      type: searchParams.get("type"),
      status: searchParams.get("status"),
      search: searchParams.get("search"),
      dateFrom: searchParams.get("dateFrom"),
      dateTo: searchParams.get("dateTo"),
      orgId: searchParams.get("orgId"),
      page: parseInt(searchParams.get("page") || "1"),
      limit: parseInt(searchParams.get("limit") || "20"),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointments" },
      { status: 500 },
    );
  }
}
