import { NextResponse } from "next/server";
import { publicCacheHeaders } from "@/lib/api/cdn-cache";
import { getSession } from "@/lib/auth-server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { reportSentryError } from "@/lib/observability/report";

type PlanGate = NonNullable<Parameters<typeof canViewPlanDetail>[0]>;

const PUBLIC_CACHE = publicCacheHeaders({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
});

/** Anything that depends on who is asking: never stored by a shared cache. */
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * GET answer for a webinar or class plan by id, behind the same visibility gate
 * the detail pages apply. A plan anyone may see keeps the shared CDN cache; one
 * only this viewer may see (an owner's draft, an org-only plan) is never cached,
 * because the cache key ignores the session. A hidden plan answers exactly like
 * a missing one, and neither 404 is cacheable: the answer depends on the viewer,
 * and a host's default must not decide it.
 */
export async function planDetailResponse<T extends PlanGate>(
  plan: T | null,
  notFoundMessage: string,
): Promise<NextResponse> {
  const notFound = () =>
    NextResponse.json(
      { error: notFoundMessage },
      { status: 404, headers: PRIVATE_NO_STORE },
    );
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
      headers: publiclyViewable ? PUBLIC_CACHE : PRIVATE_NO_STORE,
    },
  );
}

type EditorGate = {
  consultantProfile: { userId: string } | null;
  collaborators: { consultantProfile: { userId: string } | null }[];
};

/**
 * The host's editor read of a webinar or class plan: never stored by any
 * cache, and only for the plan's owner or an ACCEPTED co-host. Anyone else
 * gets the same 404 as a missing plan.
 */
export async function planEditorResponse<T extends EditorGate>(
  load: () => Promise<T | null>,
  notFoundMessage: string,
): Promise<NextResponse> {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;
  const plan = await load();
  const hosts =
    plan !== null &&
    (plan.consultantProfile?.userId === userId ||
      plan.collaborators.some((c) => c.consultantProfile?.userId === userId));
  if (!hosts) {
    return NextResponse.json(
      { error: notFoundMessage },
      { status: 404, headers: PRIVATE_NO_STORE },
    );
  }
  return NextResponse.json(
    { data: plan },
    { status: 200, headers: PRIVATE_NO_STORE },
  );
}
