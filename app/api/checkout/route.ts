import { checkoutSchema } from "@/schemas/checkout";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 checkouts per minute per user
    const rl = await applyRateLimit(checkoutLimiter, session.user.id);
    if (rl) return rl;

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);
    const isMockPayment = body.isMockPayment === true;

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    const result = await handleCheckout(
      validatedData,
      session.user.id,
      isMockPayment,
    );
    return NextResponse.json(result);
  } catch (error) {
    const classified = classifyError(error, "Checkout failed");
    logClassifiedError("Checkout", classified, error);

    return NextResponse.json(
      {
        error: classified.errorMessage,
        errorType: classified.errorType,
        timestamp: new Date().toISOString(),
      },
      { status: classified.httpStatus },
    );
  }
}
