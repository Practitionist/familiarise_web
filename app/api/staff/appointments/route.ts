/**
 * Every appointment for the back office, filtered and paged. A thin shell over
 * `getStaffAppointments`, which the page's server prefetch shares.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getStaffAppointments } from "@/lib/data/staff-appointments";
import type { Scope } from "@/lib/api/scope/parse";

/** A positive whole number, else `fallback`; never above `max`. */
const positiveInt = (fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .catch(fallback)
    .transform((n) => Math.min(n, max));

/** Paging is clamped: a page holds at most 100 rows, as the decision queue does. */
const PagingSchema = z.object({
  page: positiveInt(1, 10_000),
  limit: positiveInt(20, 100),
});

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
      ...PagingSchema.parse({
        page: searchParams.get("page") ?? undefined,
        limit: searchParams.get("limit") ?? undefined,
      }),
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
