/**
 * Every appointment for the back office, filtered and paged. A thin shell over
 * `getStaffAppointments`, which the page's server prefetch shares.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getStaffAppointments } from "@/lib/data/staff-appointments";
import type { Scope } from "@/lib/api/scope/parse";

// Coerce a query param to a positive integer; NaN / <1 / non-integer falls
// back to `fallback`. `parseInt("abc")` returns NaN (truthy), so a bare
// `|| default` never triggers — and the data layer doesn't clamp the offset.
function positiveIntParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * `?orgId=` drills into one tenant; its absence is the platform-wide view.
 * The `appointments.manage` gate is what earns `all`.
 */
function staffScope(orgId: string | null): Scope {
  return orgId ? { kind: "org", orgId } : { kind: "all" };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("appointments.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getStaffAppointments({
      type: searchParams.get("type"),
      status: searchParams.get("status"),
      search: searchParams.get("search"),
      dateFrom: searchParams.get("dateFrom"),
      dateTo: searchParams.get("dateTo"),
      scope: staffScope(searchParams.get("orgId")),
      page: positiveIntParam(searchParams.get("page"), 1),
      limit: positiveIntParam(searchParams.get("limit"), 20),
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
