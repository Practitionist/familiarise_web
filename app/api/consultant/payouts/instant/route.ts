/**
 * POST /api/consultant/payouts/instant (#1771 row 6).
 *
 * Pays the signed-in expert's READY earnings now, free and at most once per
 * IST day. At or below the auto-approve cap the payout is sent at once; above
 * it the payout waits for admin approval and the response says so.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { apiError } from "@/lib/errors/api-error";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { CronLockUnavailableError } from "@/lib/cron/with-cron-lock";
import {
  createInstantPayout,
  InstantPayoutError,
} from "@/lib/payments/payouts/payout-service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: NO_STORE },
      );
    }
    const rateLimited = await applyRateLimit(moneyOpsLimiter, session.user.id);
    if (rateLimited) return rateLimited;
    // The profile is looked up by the session's own user, so it is always theirs.
    const profile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!profile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404, headers: NO_STORE },
      );
    }

    const outcome = await createInstantPayout(profile.id);
    return NextResponse.json(outcome, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof InstantPayoutError) {
      return NextResponse.json(
        { error: error.userMessage, code: error.code, reason: error.reason },
        { status: error.httpStatus, headers: NO_STORE },
      );
    }
    if (error instanceof CronLockUnavailableError) {
      return NextResponse.json(
        {
          error: "Payouts are briefly unavailable. Please try again shortly.",
          code: "PAYOUTS_UNAVAILABLE",
        },
        { status: 503, headers: NO_STORE },
      );
    }
    return apiError({
      tag: "[Consultant.InstantPayout.POST]",
      error,
      fallbackMessage: "Could not start the instant payout",
    });
  }
}
