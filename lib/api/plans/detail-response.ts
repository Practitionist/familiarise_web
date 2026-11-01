import { NextResponse } from "next/server";
import { publicCacheHeaders } from "@/lib/api/cdn-cache";
import { getSession } from "@/lib/auth-server";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { reportSentryError } from "@/lib/observability/report";

type PlanGate = NonNullable<Parameters<typeof canViewPlanDetail>[0]>;

const PUBLIC_CACHE = publicCacheHeaders({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
});

/**
 * GET answer for a webinar or class plan by id, behind the same visibility gate
 * the detail pages apply. A plan anyone may see keeps the shared CDN cache; one
 * only this viewer may see (an owner's draft, an org-only plan) is never cached,
 * because the cache key ignores the session. A hidden plan answers exactly like
 * a missing one.
 */
export async function planDetailResponse<T extends PlanGate>(
  plan: T | null,
  notFoundMessage: string,
): Promise<NextResponse> {
  const notFound = () =>
    NextResponse.json({ error: notFoundMessage }, { status: 404 });
  if (!plan) return notFound();

  const publiclyViewable = await canViewPlanDetail(plan, null);
  if (!publiclyViewable) {
    const session = await getSession().catch((error) => {
      reportSentryError(error, { subsystem: "plans", expected: true });
      return null;
    });
    if (!(await canViewPlanDetail(plan, session))) return notFound();
  }

  return NextResponse.json(
    { data: plan },
    {
      status: 200,
      headers: publiclyViewable
        ? PUBLIC_CACHE
        : { "Cache-Control": "private, no-store" },
    },
  );
}
