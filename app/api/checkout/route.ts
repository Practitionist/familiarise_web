import { checkoutSchema } from "@/schemas/checkout";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ZodError } from "zod";
import prisma from "@/lib/prisma";
import {
  detectBuyerCountry,
  extractBuyerCountryParams,
} from "@/lib/payments/tax/buyer-country";
import { routeGateway } from "@/lib/payments/gateway-router";

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
    // Only allow mock payments in development — prevent client-side bypass in production
    const isMockPayment =
      body.isMockPayment === true && process.env.NODE_ENV === "development";

    // Detect buyer country for tax jurisdiction and gateway routing
    // Fetch user.country from DB (not on session type) for highest-confidence detection
    const userRecord = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { country: true },
    });
    const headerParams = extractBuyerCountryParams(req.headers);
    const buyerCountry = detectBuyerCountry({
      userCountry: userRecord?.country,
      ...headerParams,
    });

    // Auto-route to optimal gateway (Razorpay domestic/IBT, Stripe fallback)
    const gatewayRouting = routeGateway({
      buyerCountry,
      requestedGateway: validatedData.paymentGateway,
      amount: 0, // Amount not yet known; routing is country-based
    });

    // Override gateway with auto-routed selection
    validatedData.paymentGateway = gatewayRouting.gateway;

    console.log(
      JSON.stringify({
        event: "checkout_gateway_routed",
        buyerCountry,
        gateway: gatewayRouting.gateway,
        isIBT: gatewayRouting.isIBT,
        reason: gatewayRouting.reason,
        timestamp: new Date().toISOString(),
      }),
    );

    // Unified checkout flow: Create payment first, then appointment via webhook
    // Supports both real and mock payments via isMockPayment flag
    const result = await handleCheckout(
      validatedData,
      session.user.id,
      isMockPayment,
      buyerCountry,
    );
    return NextResponse.json(result);
  } catch (error) {
    // ZodError from checkoutSchema.parse() — extract first human-readable message
    if (error instanceof ZodError) {
      const firstMessage = error.issues[0]?.message ?? "Invalid request";
      const lowerMsg = firstMessage.toLowerCase();
      const isAvailability =
        lowerMsg.includes("slot") ||
        lowerMsg.includes("passed") ||
        lowerMsg.includes("too soon") ||
        lowerMsg.includes("availability");
      return NextResponse.json(
        {
          error: firstMessage,
          errorType: isAvailability ? "AVAILABILITY_ERROR" : "UNKNOWN_ERROR",
          timestamp: new Date().toISOString(),
        },
        { status: 400 },
      );
    }

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
