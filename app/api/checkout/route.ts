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
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { routeGateway } from "@/lib/payments/gateway-router";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";

// #828 — replay the original checkout response for a duplicate attempt. The
// stored Payment carries enough for the client to reopen the gateway with the
// SAME order instead of minting (and possibly paying) a second one. Scoped to
// the caller's userId so a guessed key can't read someone else's payment.
async function replayByIdempotencyKey(userId: string, key: string) {
  const existing = await prisma.payment.findFirst({
    where: { clientIdempotencyKey: key, userId },
    select: {
      paymentIntent: true,
      paymentStatus: true,
      amount: true,
      currency: true,
      appointmentId: true,
      isMockPayment: true,
    },
  });
  if (!existing) return null;
  if (existing.paymentStatus === "SUCCEEDED") {
    return NextResponse.json({
      success: true,
      reused: true,
      skipPayment: true,
      appointmentId: existing.appointmentId ?? undefined,
      message: "This checkout was already completed.",
    });
  }
  if (existing.paymentStatus === "PENDING") {
    return NextResponse.json({
      success: true,
      reused: true,
      orderId: existing.paymentIntent,
      paymentIntent: { id: existing.paymentIntent, client_secret: null },
      amount: Number(existing.amount),
      currency: existing.currency,
      isMockPayment: existing.isMockPayment,
      message: "Resuming your in-progress checkout.",
    });
  }
  // Terminal (FAILED/CANCELED/...) — this logical attempt is dead; the client
  // must mint a fresh key for a new attempt (the wallet top-up contract).
  return NextResponse.json(
    {
      error:
        "A previous attempt for this checkout already failed. Refresh and try again.",
      errorType: "IDEMPOTENT_REPLAY_TERMINAL",
      timestamp: new Date().toISOString(),
    },
    { status: 409 },
  );
}

export async function POST(req: NextRequest) {
  // #828 — hoisted so the P2002 catch can replay without re-reading the
  // (already consumed) request body.
  let replayUserId: string | undefined;
  let replayKey: string | undefined;
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    replayUserId = session.user.id;

    // Rate limit: 5 checkouts per minute per user
    const rl = await applyRateLimit(checkoutLimiter, session.user.id);
    if (rl) return rl;

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);
    // Only allow mock payments in development — prevent client-side bypass in production
    const isMockPayment =
      body.isMockPayment === true && process.env.NODE_ENV === "development";

    // #828 — fast-path replay: a double-click / network retry / second tab
    // with the same key gets the original attempt's response, never a second
    // Payment + tentative slots + gateway order.
    replayKey = validatedData.clientIdempotencyKey;
    if (replayKey) {
      const replay = await replayByIdempotencyKey(session.user.id, replayKey);
      if (replay) return replay;
    }

    const { buyerCountry } = await resolveCheckoutTaxContext({
      userId: session.user.id,
      headers: req.headers,
    });

    // Auto-route to optimal gateway (Razorpay domestic/IBT, Stripe fallback)
    const gatewayRouting = routeGateway({
      buyerCountry,
      requestedGateway: validatedData.paymentGateway,
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
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    // #828 — two concurrent identical requests can both miss the replay
    // lookup; the loser's Payment.create dies on the unique key. Replay the
    // winner's response instead of surfacing a 500.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      String(error.meta?.target ?? "").includes("clientIdempotencyKey") &&
      replayUserId &&
      replayKey
    ) {
      const replay = await replayByIdempotencyKey(replayUserId, replayKey);
      if (replay) return replay;
    }
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
