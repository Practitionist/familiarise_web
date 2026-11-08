import { NextRequest } from "next/server";

import { fetchClassPlanDetail } from "@/lib/data/plan-details";
import { planEditorResponse } from "@/lib/api/plans/detail-response";
import { apiError } from "@/lib/errors";

/**
 * GET /api/plans/classes/[classPlanId]/editor — the offering editor's read: the
 * same plan detail as the public GET, but host or co-host only and never
 * cached, so a save never starts from a stale copy.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  try {
    const { classPlanId } = await params;
    return await planEditorResponse(
      () => fetchClassPlanDetail(classPlanId),
      "Class plan not found",
    );
  } catch (error) {
    return apiError({ tag: "[ClassPlan.Editor.GET]", error });
  }
}
