import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { refusalJson } from "@/lib/errors/refusal-json";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";
import { getUserCredits } from "@/lib/referrals/service";
import { applyRateLimit, checkoutContextLimiter } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const session = await getSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // #1583 E-P1-06 — the context read resolves the buyer's tax profile and
  // country per call; its own bucket, see checkoutContextLimiter for why.
  const rl = await applyRateLimit(checkoutContextLimiter, session.user.id);
  if (rl) return rl;

  try {
    // Credits ride along so checkout pages pay ONE round trip instead of two
    // (tax context + referral balance fired independently on every mount).
    // `null` means the credits read failed — distinct from zero, matching the
    // checkout UI's "failed fetch must not read as no credits" contract. The
    // standalone /api/referrals/credits/available route stays as fallback.
    const [taxContext, credits] = await Promise.all([
      resolveCheckoutTaxContext({
        userId: session.user.id,
        headers: req.headers,
      }),
      getUserCredits(session.user.id)
        .then(({ totalAvailable }) => totalAvailable as number | null)
        .catch((creditsError) => {
          Sentry.captureException(
            creditsError instanceof Error
              ? creditsError
              : new Error(String(creditsError)),
            { tags: { subsystem: "checkout-context-credits" } },
          );
          return null;
        }),
    ]);

    return NextResponse.json({ ...taxContext, referralCreditsPaise: credits });
  } catch (error) {
    // A typed refusal (GST_CONFIG_INVALID on a malformed PLATFORM_GSTIN) is an answer, not a bug.
    const refused = refusalJson(error);
    if (refused) return refused;
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "checkout" } },
    );
    console.error("Checkout context error:", error);
    return NextResponse.json(
      { error: "Failed to resolve checkout tax context" },
      { status: 500 },
    );
  }
}
