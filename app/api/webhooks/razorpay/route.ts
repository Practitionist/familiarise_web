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
import { webhookRateLimiter, createRateLimitResponse } from "../../../../utils/rateLimiter";

export async function POST(req: NextRequest) {
  // Apply rate limiting for webhook protection
  const rateLimitResult = webhookRateLimiter.checkLimit(req);
  if (!rateLimitResult.allowed) {
    console.warn(
      `Webhook rate limit exceeded for IP: ${req.headers.get("x-forwarded-for") ?? "unknown"}. ` +
      `Retry after: ${rateLimitResult.retryAfter}s`
    );
    return createRateLimitResponse(rateLimitResult);
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body, eventId } = await verifyWebhookSignature(
    req,
    secret,
    "razorpay",
  );
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature or replay attack detected" }, { status: 400 });
  }

  try {
    const event = JSON.parse(body);
    const { event: eventType } = razorpayBaseEventSchema.parse(event);

    console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
      payload: event.payload,
    });

    switch (eventType) {
      case "payment.captured": {
        const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
        
        // Extract amount and currency for verification
        const capturedPayment = capturedEvent.payload.payment.entity;
        const webhookAmount = capturedPayment.amount / 100; // Convert from paise to rupees
        const webhookCurrency = capturedPayment.currency;
        
        await handlePaymentSuccess(
          capturedPayment.order_id,
          capturedPayment.notes || {},
          webhookAmount,
          webhookCurrency,
        );
        break;
      }

      case "order.paid": {
        const paidEvent = razorpayOrderPaidEventSchema.parse(event);
        
        // Extract amount and currency for verification
        const paidOrder = paidEvent.payload.order.entity;
        const orderAmount = paidOrder.amount / 100; // Convert from paise to rupees
        const orderCurrency = paidOrder.currency;
        
        await handlePaymentSuccess(
          paidOrder.id,
          paidOrder.notes || {},
          orderAmount,
          orderCurrency,
        );
        break;
      }

      case "payment.failed": {
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        await handlePaymentFailure(failedEvent.payload.payment.entity.order_id);
        break;
      }

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
