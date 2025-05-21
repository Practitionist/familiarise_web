import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import crypto from "crypto";

// Verify Xflow webhook signature
function verifySignature(body: string, signature: string, secret: string) {
  const hmac = crypto.createHmac("sha256", secret);
  const digest = hmac.update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const headersList = await headers();
    const signature = headersList.get("x-xflow-signature") || "";
    const secret = process.env.XFLOW_WEBHOOK_SECRET;

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
    const { type, data } = event;

    // Handle different event types
    switch (type) {
      case "payment.succeeded":
        // Update payment status
        await prisma.payment.updateMany({
          where: {
            paymentIntent: data.id.toString(),
          },
          data: {
            paymentStatus: "SUCCEEDED",
            receiptUrl: data.receipt_url,
          },
        });
        break;

      case "payment.failed":
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

      case "refund.created":
        // Handle refund
        break;

      case "subscription.created":
        // Handle new subscription
        break;

      case "subscription.cancelled":
        // Handle subscription cancellation
        break;

      case "subscription.updated":
        // Handle subscription update
        break;

      default:
        console.log(`Unhandled event type: ${type}`);
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
