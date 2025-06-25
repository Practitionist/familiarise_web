import { NextRequest, NextResponse } from "next/server";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  verifyWebhookSignature,
} from "../utils";
import {
  stripeBaseEventSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePaymentIntentFailedEventSchema,
} from "../../../../schemas/webhooks/stripe";
import { webhookRateLimiter, createRateLimitResponse } from "../../../../utils/rateLimiter";

export async function POST(req: NextRequest) {
  // Apply rate limiting for webhook protection
  const rateLimitResult = webhookRateLimiter.checkLimit(req);
  if (!rateLimitResult.allowed) {
    const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    console.warn(
      `Webhook rate limit exceeded for IP: ${clientIP}. ` +
      `Retry after: ${rateLimitResult.retryAfter}s`
    );
    return createRateLimitResponse(rateLimitResult);
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body, eventId } = await verifyWebhookSignature(req, secret, "stripe");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature or replay attack detected" }, { status: 400 });
  }

  try {
    const event = JSON.parse(body);
    const { type: eventType } = stripeBaseEventSchema.parse(event);

    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      payload: event.data.object,
    });

    switch (eventType) {
      case "payment_intent.succeeded": {
        const succeededEvent =
          stripePaymentIntentSucceededEventSchema.parse(event);
        
        // Extract amount and currency for verification
        const paymentIntent = succeededEvent.data.object;
        const webhookAmount = paymentIntent.amount / 100; // Convert from cents to currency unit
        const webhookCurrency = paymentIntent.currency.toUpperCase();
        
        await handlePaymentSuccess(
          paymentIntent.id,
          paymentIntent.metadata || {},
          webhookAmount,
          webhookCurrency,
        );
        break;
      }

      case "payment_intent.payment_failed": {
        const failedEvent = stripePaymentIntentFailedEventSchema.parse(event);
        await handlePaymentFailure(failedEvent.data.object.id);
        break;
      }

      default:
        console.log(`📄 Unhandled Stripe event type: ${eventType}`);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
