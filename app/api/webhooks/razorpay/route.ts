import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-razorpay-signature");

    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error("RAZORPAY_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    // Verify webhook signature
    if (signature) {
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("Razorpay webhook signature verification failed");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 },
        );
      }
    }

    const event = JSON.parse(body);

    // Log all webhook events
    console.log(`🔔 Razorpay Webhook Event: ${event.event}`, {
      account_id: event.account_id,
      entity: event.entity,
      created_at: new Date(event.created_at * 1000).toISOString(),
      payload: event.payload,
    });

    // Handle different event types
    switch (event.event) {
      case "payment.captured":
        const payment = event.payload.payment.entity;
        console.log("✅ Payment captured:", {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          order_id: payment.order_id,
          notes: payment.notes,
          status: payment.status,
        });

        // Update booking status if notes contain booking info
        if (payment.notes && payment.notes.bookingId) {
          try {
            // Note: Update based on your actual booking table structure
            console.log(
              "✅ Booking confirmed via Razorpay:",
              payment.notes.bookingId,
            );
          } catch (error) {
            console.error("Failed to update booking:", error);
          }
        }
        break;

      case "payment.failed":
        const failedPayment = event.payload.payment.entity;
        console.log("❌ Payment failed:", {
          id: failedPayment.id,
          order_id: failedPayment.order_id,
          error_code: failedPayment.error_code,
          error_description: failedPayment.error_description,
          notes: failedPayment.notes,
        });
        break;

      case "order.paid":
        const order = event.payload.order.entity;
        console.log("✅ Order paid:", {
          id: order.id,
          amount: order.amount,
          amount_paid: order.amount_paid,
          currency: order.currency,
          status: order.status,
          notes: order.notes,
        });
        break;

      case "subscription.charged":
        const subscription = event.payload.subscription.entity;
        console.log("✅ Subscription charged:", {
          id: subscription.id,
          status: subscription.status,
          current_start: new Date(
            subscription.current_start * 1000,
          ).toISOString(),
          current_end: new Date(subscription.current_end * 1000).toISOString(),
          notes: subscription.notes,
        });
        break;

      case "subscription.activated":
        const activatedSub = event.payload.subscription.entity;
        console.log("🆕 Subscription activated:", {
          id: activatedSub.id,
          status: activatedSub.status,
          plan_id: activatedSub.plan_id,
          customer_id: activatedSub.customer_id,
        });
        break;

      default:
        console.log(`📄 Unhandled Razorpay event type: ${event.event}`);
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
