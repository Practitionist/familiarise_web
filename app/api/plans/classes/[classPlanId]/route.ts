import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { fetchClassPlanDetail } from "@/lib/data/plan-details";
import { apiError } from "@/lib/errors";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  try {
    const { classPlanId } = await params;
    const classPlan = await fetchClassPlanDetail(classPlanId);

    if (!classPlan) {
      return NextResponse.json(
        { error: "Class plan not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { data: classPlan },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    return apiError({ tag: "[ClassPlan.GET]", error });
  }
}

/**
 * Retired. Plan writes go through POST/PATCH on
 * /api/bookings/classes/crud-with-plan, which validates with
 * ClassPlanSchema and maintains the plan + contents + slot run atomically.
 * This legacy PUT bypassed Zod entirely, so retiring it (no callers remained)
 * removes the last unvalidated write path to ClassPlan.
 */
export async function PUT() {
  return NextResponse.json(
    {
      error:
        "PUT is no longer supported on this route. Use POST/PATCH on /api/bookings/classes/crud-with-plan.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

/**
 * Retired alongside PUT: deletion is a soft withdrawal via archivedAt
 * (#catalog-archive), never a hard delete — the legacy DELETE cascaded through
 * to Appointment and Payment rows.
 */
export async function DELETE() {
  return NextResponse.json(
    {
      error:
        "DELETE is no longer supported on this route. Plans are withdrawn via archivedAt, not deleted.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
