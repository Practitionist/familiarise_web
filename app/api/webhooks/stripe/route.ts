import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import prisma from "@/lib/prisma";
import { stripeClient } from "@/lib/payment";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature")!;
    
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }

    let event: Stripe.Event;

    try {
      event = stripeClient.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // Log all webhook events
    console.log(`🔔 Stripe Webhook Event: ${event.type}`, {
      id: event.id,
      created: new Date(event.created * 1000).toISOString(),
      data: event.data.object,
    });

    // Handle different event types
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log("✅ Payment succeeded:", {
          id: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          metadata: paymentIntent.metadata,
        });
        
        // Update booking status if metadata contains booking info
        if (paymentIntent.metadata.bookingId) {
          try {
            await prisma.consultation.update({
              where: { id: paymentIntent.metadata.bookingId },
              data: { requestStatus: "APPROVED" },
            });
            console.log("✅ Booking confirmed:", paymentIntent.metadata.bookingId);
          } catch (error) {
            console.error("Failed to update booking:", error);
          }
        }
        break;

      case "payment_intent.payment_failed":
        const failedPayment = event.data.object as Stripe.PaymentIntent;
        console.log("❌ Payment failed:", {
          id: failedPayment.id,
          last_payment_error: failedPayment.last_payment_error,
          metadata: failedPayment.metadata,
        });
        break;

      case "invoice.payment_succeeded":
        const invoice = event.data.object as Stripe.Invoice;
        console.log("✅ Invoice payment succeeded:", {
          id: invoice.id,
          subscription_id: invoice.parent?.subscription_details?.subscription,
          amount_paid: invoice.amount_paid,
          customer: invoice.customer,
        });
        break;

      case "customer.subscription.created":
        const subscription = event.data.object as Stripe.Subscription;
        console.log("🆕 Subscription created:", {
          id: subscription.id,
          customer: subscription.customer,
          status: subscription.status,
          billing_cycle_anchor: new Date(subscription.billing_cycle_anchor * 1000).toISOString(),
          start_date: new Date(subscription.start_date * 1000).toISOString(),
        });
        break;

      default:
        console.log(`📄 Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
} 