import { NextRequest } from "next/server";

import { fetchWebinarPlanDetail } from "@/lib/data/plan-details";
import { planEditorResponse } from "@/lib/api/plans/detail-response";
import { apiError } from "@/lib/errors";

/**
 * GET /api/plans/webinars/[webinarPlanId]/editor: the offering editor's read. The same
 * plan detail as the public GET, for the plan's manager and its accepted
 * collaborators only, and never cached, so a save never starts from a stale copy.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const { webinarPlanId } = await params;
    return await planEditorResponse(
      { planType: "webinar", planId: webinarPlanId },
      () => fetchWebinarPlanDetail(webinarPlanId),
      "Webinar plan not found",
    );
  } catch (error) {
    return apiError({ tag: "[WebinarPlan.Editor.GET]", error });
  }
}
