import * as Sentry from "@sentry/nextjs";
import { checkoutSchema } from "@/schemas/checkout";
import { handleCheckout } from "@/lib/payments/operations/checkout";
import {
  classifyError,
  logClassifiedError,
} from "@/lib/errors/classification/payment-error-classification";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import {
  EventCheckoutLockUnavailableError,
  BookingLockUnavailableError,
} from "@/utils/appointmentlock";
import { WalletFrozenError } from "@/lib/payments/wallet-freeze";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { replayByIdempotencyKey } from "@/lib/payments/operations/checkout-replay";
import { routeGateway } from "@/lib/payments/gateway-router";
import { resolveCheckoutTaxContext } from "@/lib/payments/tax/checkout-context";

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

    // #676 CN-1 — the event-checkout lock fails CLOSED on a Redis outage with a
    // typed 503; classifyError is message-only and would mislabel it 500. Honor
    // the structured status so the client sees a retryable 503, not a 500.
    if (error instanceof EventCheckoutLockUnavailableError) {
      return NextResponse.json(
        {
          error:
            "The booking system is briefly busy and your card was not charged. Please try again in a moment.",
          errorType: error.code,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #1169 PR 1 — the slot/consultee booking locks fail closed the same way;
    // without this branch classifyError mislabelled the outage as a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        {
          error:
            "The booking system is briefly busy and your card was not charged. Please try again in a moment.",
          errorType: error.code,
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    // #837 — a frozen wallet (ledger drift caught by reconcile) is a specific,
    // retryable 409, not a generic 500. classifyError is message-only and would
    // mislabel it; honor the structured httpStatus like the lock error above.
    if (error instanceof WalletFrozenError) {
      return NextResponse.json(
        {
          error:
            "This organization's wallet is temporarily on hold pending a balance review. Your card was not charged. Please try again shortly or contact support.",
          errorType: "WALLET_FROZEN",
          timestamp: new Date().toISOString(),
        },
        { status: error.httpStatus },
      );
    }

    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "checkout" } });
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
