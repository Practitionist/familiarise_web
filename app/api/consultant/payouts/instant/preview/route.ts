/**
 * GET /api/consultant/payouts/instant/preview (#1771 row 6).
 *
 * What "Get paid now" would send the signed-in expert: the READY total, the
 * TDS estimate, the net amount, the "Free · once a day" label, and when the
 * next instant payout opens if today's has been used.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { apiError } from "@/lib/errors/api-error";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { previewInstantPayout } from "@/lib/payments/payouts/payout-service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: NO_STORE },
      );
    }
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

    const preview = await previewInstantPayout(profile.id);
    return NextResponse.json(
      { enabled: ENABLE_LIVE_PAYOUTS, ...preview },
      { headers: NO_STORE },
    );
  } catch (error) {
    return apiError({
      tag: "[Consultant.InstantPayout.Preview.GET]",
      error,
      fallbackMessage: "Could not load the instant payout preview",
    });
  }
}
