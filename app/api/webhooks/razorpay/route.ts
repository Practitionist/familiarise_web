import { NextRequest, NextResponse } from "next/server";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  verifyWebhookSignature,
} from "../utils";
import {
  razorpayBaseEventSchema,
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
} from "../../../../schemas/webhooks/razorpay";

export async function POST(req: NextRequest) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body } = await verifyWebhookSignature(req, secret, "razorpay");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const event = JSON.parse(body);
    const { event: eventType } = razorpayBaseEventSchema.parse(event);

    console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
      payload: event.payload,
    });

    switch (eventType) {
      case "payment.captured":
        const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
        await handlePaymentSuccess(
          capturedEvent.payload.payment.entity.order_id,
          capturedEvent.payload.payment.entity.notes || {},
        );
        break;

      case "order.paid":
        const paidEvent = razorpayOrderPaidEventSchema.parse(event);
        await handlePaymentSuccess(
          paidEvent.payload.order.entity.id,
          paidEvent.payload.order.entity.notes || {},
        );
        break;

      case "payment.failed":
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        await handlePaymentFailure(failedEvent.payload.payment.entity.order_id);
        break;

      default:
        console.log(`📄 Unhandled Razorpay event type: ${eventType}`);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
