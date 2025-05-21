import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import crypto from "crypto";

// Verify Lemon Squeezy webhook signature
function verifySignature(body: string, signature: string, secret: string) {
  const hmac = crypto.createHmac("sha256", secret);
  const digest = hmac.update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const headersList = await headers();
    const signature = headersList.get("x-signature") || "";
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

    if (!signature || !secret) {
      return NextResponse.json(
        { error: "Missing signature or secret" },
        { status: 401 },
      );
    }

    // Verify webhook signature
    if (!verifySignature(body, signature, secret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = JSON.parse(body);
    const { meta, data } = event;

    // Handle different event types
    switch (meta.event_name) {
      case "order_created":
        // Handle new order
        break;

      case "order_refunded":
        // Handle refund
        break;

      case "subscription_created":
        // Handle new subscription
        break;

      case "subscription_cancelled":
        // Handle subscription cancellation
        break;

      case "subscription_resumed":
        // Handle subscription resumption
        break;

      case "subscription_expired":
        // Handle subscription expiration
        break;

      case "payment_success":
        // Update payment status
        await prisma.payment.updateMany({
          where: {
            paymentIntent: data.id.toString(),
          },
          data: {
            paymentStatus: "SUCCEEDED",
            receiptUrl: data.attributes.receipt_url,
          },
        });
        break;

      case "payment_failed":
        // Update payment status
        await prisma.payment.updateMany({
          where: {
            paymentIntent: data.id.toString(),
          },
          data: {
            paymentStatus: "FAILED",
          },
        });
        break;

      default:
        console.log(`Unhandled event type: ${meta.event_name}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
