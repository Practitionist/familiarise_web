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

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body } = await verifyWebhookSignature(req, secret, "stripe");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const event = JSON.parse(body);
    const { type: eventType } = stripeBaseEventSchema.parse(event);

    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      payload: event.data.object,
    });

    switch (eventType) {
      case "payment_intent.succeeded":
        const succeededEvent = stripePaymentIntentSucceededEventSchema.parse(event);
        await handlePaymentSuccess(
          succeededEvent.data.object.id,
          succeededEvent.data.object.metadata || {},
        );
        break;

      case "payment_intent.payment_failed":
        const failedEvent = stripePaymentIntentFailedEventSchema.parse(event);
        await handlePaymentFailure(failedEvent.data.object.id);
        break;

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
