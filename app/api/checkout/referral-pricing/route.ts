import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";
import { resolveCheckoutAttribution } from "@/lib/referrals/attribution";
import {
  EXPERT_VIA_COOKIE,
  parseViaToken,
} from "@/lib/referrals/attribution-token-shape";
import type { ReferralPricing } from "@/lib/referrals/promo-math";

const querySchema = z.object({
  consultantProfileId: z.string().min(1).max(64),
});

/**
 * The referral terms checkout will apply for this buyer and expert, so the price preview
 * matches the charge: the welcome discount (personal funding) and the credit cap.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;
  const query = querySchema.safeParse({
    consultantProfileId: req.nextUrl.searchParams.get("consultantProfileId"),
  });
  if (!query.success) {
    return NextResponse.json(
      { error: "consultantProfileId is required" },
      { status: 400 },
    );
  }
  try {
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: query.data.consultantProfileId },
      select: { id: true, userId: true },
    });
    const attribution = await resolveCheckoutAttribution(prisma, {
      buyerUserId: session.user.id,
      consultantProfileId: consultant?.id ?? null,
      consultantUserId: consultant?.userId ?? null,
      viaToken: parseViaToken(req.cookies.get(EXPERT_VIA_COOKIE)?.value),
      orgFunded: false,
      hasDiscountCode: false,
    });
    const body: ReferralPricing = {
      welcomeDiscount: attribution.welcomeDiscount,
      creditCapBps: attribution.creditCapBps,
    };
    return NextResponse.json(body);
  } catch (error) {
    reportSentryError(error, { subsystem: "checkout", op: "referral-pricing" });
    return NextResponse.json(
      { error: "Failed to resolve referral pricing" },
      { status: 500 },
    );
  }
}
