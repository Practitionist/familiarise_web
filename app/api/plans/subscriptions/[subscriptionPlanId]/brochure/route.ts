import type { NextRequest } from "next/server";
import { handlePlanBrochureDownload } from "@/lib/pdf/plan-brochure-handler";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  const { subscriptionPlanId } = await params;
  return handlePlanBrochureDownload(
    request,
    subscriptionPlanId,
    "subscriptions",
  );
}
