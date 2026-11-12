import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";
import { ownOpenOrderHoldsForCheckout } from "@/lib/payments/checkout/own-open-order";
import { checkoutSchema } from "@/schemas/checkout";

/**
 * The referral credit the buyer's own open order for this item holds, which
 * checkout counts as available, so a reload or second tab offers the same credit.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;
  const parsed = checkoutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A checkout item is required" },
      { status: 400 },
    );
  }
  try {
    const held = await ownOpenOrderHoldsForCheckout(
      session.user.id,
      parsed.data,
    );
    return NextResponse.json({ heldCreditsPaise: held.creditsPaise });
  } catch (error) {
    reportSentryError(error, { subsystem: "checkout", op: "own-open-order" });
    return NextResponse.json(
      { error: "Failed to read your open order" },
      { status: 500 },
    );
  }
}
