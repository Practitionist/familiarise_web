import type { NextRequest } from "next/server";
import { handlePlanBrochureDownload } from "@/lib/pdf/plan-brochure-handler";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const { webinarPlanId } = await params;
  return handlePlanBrochureDownload(request, webinarPlanId, "webinars");
}
