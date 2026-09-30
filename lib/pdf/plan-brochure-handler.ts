import { NextResponse, type NextRequest } from "next/server";
import {
  fetchClassPlanDetail,
  fetchConsultationPlanDetail,
  fetchSubscriptionPlanDetail,
  fetchWebinarPlanDetail,
} from "@/lib/data/plan-details";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { getSession } from "@/lib/auth-server";
import {
  applyRateLimit,
  brochureDownloadLimiter,
  getClientIp,
} from "@/lib/rate-limit";
import { reportSentryError } from "@/lib/observability/report";
import { getAppUrl } from "@/lib/url";
import {
  brochureFilename,
  createPlanBrochureData,
  type BrochurePlanType,
} from "./plan-brochure-data";
import { renderPlanBrochure } from "./plan-brochure-renderer";

const privateHeaders = { "Cache-Control": "private, no-store" };

function fetchPlanByType(planId: string, type: BrochurePlanType) {
  switch (type) {
    case "classes":
      return fetchClassPlanDetail(planId);
    case "webinars":
      return fetchWebinarPlanDetail(planId);
    case "consultations":
      return fetchConsultationPlanDetail(planId);
    case "subscriptions":
      return fetchSubscriptionPlanDetail(planId);
  }
}

/** Fresh read + the detail page's gate, including owner previews and org-only plans. */
export async function handlePlanBrochureDownload(
  request: NextRequest,
  planId: string,
  type: BrochurePlanType,
) {
  const limited = await applyRateLimit(
    brochureDownloadLimiter,
    getClientIp(request),
  );
  if (limited) return limited;
  try {
    const [plan, session] = await Promise.all([
      fetchPlanByType(planId, type),
      getSession(true).catch((error) => {
        reportSentryError(error, { subsystem: "plans", expected: true });
        return null;
      }),
    ]);
    if (!plan || !(await canViewPlanDetail(plan, session))) {
      return NextResponse.json(
        { error: "Plan not found" },
        { status: 404, headers: privateHeaders },
      );
    }
    const data = createPlanBrochureData(plan, type, getAppUrl());
    const pdf = await renderPlanBrochure(data);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${brochureFilename(plan.title)}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    reportSentryError(error, { subsystem: "plans", expected: false });
    return NextResponse.json(
      { error: "Couldn’t prepare the brochure PDF. Please try again." },
      { status: 500, headers: privateHeaders },
    );
  }
}
