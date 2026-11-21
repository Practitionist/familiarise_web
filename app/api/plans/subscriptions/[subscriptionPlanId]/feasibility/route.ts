import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  assessExpertFeasibility,
  buyerFeasibilityNotice,
  firstWeekPlaceable,
  PLAN_FEASIBILITY_WEEKS,
} from "@/lib/booking/feasibility";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { publicProfileFacts } from "@/lib/profiles/public-profile";
import { planBuyBlockedFor } from "@/lib/booking/plan-demand";
import { leadMsFor } from "@/lib/booking/lead-time";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import { MAX_SUBSCRIPTION_SESSIONS_PER_DAY } from "@/utils/scheduling-engine/sessionCaps";

const QuerySchema = z.object({
  startsAt: z.string().datetime().optional(),
});

/**
 * GET /api/plans/subscriptions/[subscriptionPlanId]/feasibility
 *
 * What a buyer is told at checkout about the expert's room for this plan over
 * its first weeks, counting today's bookings and other sold plans' unplaced
 * sessions: a notice when some week can't hold the cadence, and whether
 * checkout will refuse because the first week holds nothing (409
 * `NOT_PLACEABLE` at the checkout itself). Counts only, never times or other
 * buyers' bookings.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;

  const query = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!query.success) {
    return NextResponse.json(
      { error: "startsAt must be an ISO date-time" },
      { status: 400 },
    );
  }

  try {
    const { subscriptionPlanId } = await params;
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
      select: {
        status: true,
        visibility: true,
        organizationId: true,
        archivedAt: true,
        consultantProfileId: true,
        sessionsPerWeek: true,
        sessionDurationInHours: true,
        consultantProfile: {
          select: {
            ...publicProfileFacts,
            user: { select: { timezone: true } },
          },
        },
      },
    });
    // The by-id plan read's rule: a plan its reader may not open is not found here either.
    if (!plan || !(await canViewPlanDetail(plan, session))) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const now = Date.now();
    const startsAtMs = query.data.startsAt
      ? Date.parse(query.data.startsAt)
      : now;
    const zone = resolveSchedulingTimezone(
      plan.consultantProfile?.user?.timezone,
    );
    const report = await assessExpertFeasibility(prisma, {
      consultantProfileId: plan.consultantProfileId,
      zone,
      sessionMinutes: Math.round(plan.sessionDurationInHours * 60),
      sessionsPerWeek: plan.sessionsPerWeek,
      perDayCap: MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
      notBeforeMs: Math.max(
        startsAtMs,
        now + leadMsFor("allocate", { settled: true }),
      ),
      weeks: PLAN_FEASIBILITY_WEEKS,
      countBookings: true,
      // The checkout gate's count, so the notice and the refusal agree.
      planDemand: { excludeSubscriptionIds: [] },
    });

    return NextResponse.json(
      {
        verdict: report.verdict,
        firstWeekPlaceable: firstWeekPlaceable(report),
        sessionsPerWeek: plan.sessionsPerWeek,
        notice: buyerFeasibilityNotice(report, plan.sessionsPerWeek),
        // The checkout's own PLAN_CLIENTS_FULL answer, shown before the buyer pays.
        fullyBooked: await planBuyBlockedFor(
          prisma,
          plan.consultantProfileId,
          session.user.id,
        ),
        // The zone checkout cuts the first cycle in, so the buyer sees the same dates.
        zone,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "plan-feasibility" } });
    return NextResponse.json(
      { error: "Couldn't check this expert's availability" },
      { status: 500 },
    );
  }
}
