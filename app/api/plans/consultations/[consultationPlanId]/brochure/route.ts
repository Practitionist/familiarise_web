import type { NextRequest } from "next/server";
import { handlePlanBrochureDownload } from "@/lib/pdf/plan-brochure-handler";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultationPlanId: string }> },
) {
  const { consultationPlanId } = await params;
  return handlePlanBrochureDownload(
    request,
    consultationPlanId,
    "consultations",
  );
}
