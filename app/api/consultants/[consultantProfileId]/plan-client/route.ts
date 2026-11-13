import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { holdsPlanWith } from "@/lib/booking/plan-demand";
import prisma from "@/lib/prisma";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";
import type { ViewerPlanClient } from "@/schemas/plan-clients";

/**
 * GET — whether the signed-in viewer already holds one of this expert's 1:1
 * plans, so a "Fully booked" storefront still lets them buy. Only the viewer's
 * own fact; the expert's limit and client count never appear.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ consultantProfileId: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;
  try {
    const { consultantProfileId } = await params;
    const data: ViewerPlanClient = {
      holdsPlan: await holdsPlanWith(
        prisma,
        consultantProfileId,
        session.user.id,
      ),
    };
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "plans" } });
    return NextResponse.json(
      { error: "Couldn't check your plans with this expert" },
      { status: 500 },
    );
  }
}
