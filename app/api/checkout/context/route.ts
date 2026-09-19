import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { getSession } from "@/lib/auth-server";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const session = await getSession();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  // #1583 E-P1-06 — the context read resolves the buyer's tax profile and
  // country per call; its own bucket, see checkoutContextLimiter for why.
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;

  try {
    const taxContext = await resolveCheckoutTaxContext({
      userId: session.user.id,
      headers: req.headers,
    });

    return NextResponse.json(taxContext, {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "checkout" } },
    );
    console.error("Checkout context error:", error);
    return NextResponse.json(
      { error: "Failed to resolve checkout tax context" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
