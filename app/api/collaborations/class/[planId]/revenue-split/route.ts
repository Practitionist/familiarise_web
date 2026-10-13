import { NextRequest } from "next/server";
import { handlePlanRevenueSplitGet } from "@/lib/api/collaborations/plan-route";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  const { planId } = await params;
  return handlePlanRevenueSplitGet("class", planId, req);
}
