import Stripe from "stripe";
import Razorpay from "razorpay";
import { PaymentGateway } from "@prisma/client";
import crypto from "crypto";

// Initialize payment clients
export const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-05-28.basil",
});

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

export interface PaymentIntentParams {
  amount: number;
  currency: string;
  metadata: {
    appointmentId: string;
    appointmentType: string;
    [key: string]: string;
  };
  paymentGateway: PaymentGateway;
}

export interface PaymentIntent {
  id: string;
  client_secret: string;
  amount: number;
  currency: string;
  status: string;
}

export async function createPaymentIntent({
  amount,
  currency,
  metadata,
  paymentGateway,
}: PaymentIntentParams): Promise<PaymentIntent> {
  try {
    if (paymentGateway === "STRIPE") {
      const intent = await stripeClient.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        metadata,
        automatic_payment_methods: {
          enabled: true,
        },
      });

      return {
        id: intent.id,
        client_secret: intent.client_secret!,
        amount: intent.amount / 100, // Convert back to whole currency
        currency: intent.currency,
        status: intent.status,
      };
    } else if (paymentGateway === "RAZORPAY") {
      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100), // Convert to paise
        currency,
        notes: metadata,
        receipt: `receipt_${Date.now()}`,
      });

      return {
        id: order.id,
        client_secret: order.id, // Razorpay uses order ID as client secret
        amount: Number(order.amount) / 100,
        currency: order.currency,
        status: order.status,
      };
    }

    throw new Error(`Unsupported payment gateway: ${paymentGateway}`);
  } catch (error) {
    console.error("Payment intent creation failed:", error);

    // Provide more specific error messages
    if (error instanceof Error) {
      // Stripe errors
      if (
        error.message.includes("Invalid API key") ||
        error.message.includes("api_key")
      ) {
        throw new Error("Authentication failed - Invalid Stripe API key");
      }
      if (
        error.message.includes("testmode") ||
        error.message.includes("livemode")
      ) {
        throw new Error("Authentication failed - API key mode mismatch");
      }
      // Razorpay errors
      if (error.message.includes("BAD_REQUEST_ERROR")) {
        throw new Error("Authentication failed - Invalid Razorpay credentials");
      }
      if (error.message.includes("GATEWAY_ERROR")) {
        throw new Error("Payment gateway temporarily unavailable");
      }
    }

    throw new Error("Failed to create payment intent");
  }
}

export async function cancelPaymentIntent(
  paymentIntentId: string,
  reason: string = "requested_by_customer",
): Promise<void> {
  try {
    if (paymentIntentId.startsWith("pi_")) {
      // Stripe payment intent
      await stripeClient.paymentIntents.cancel(paymentIntentId, {
        cancellation_reason: reason === "requested_by_customer" ? "requested_by_customer" : "abandoned",
      });
      console.log(`✅ Stripe payment intent cancelled: ${paymentIntentId} - Reason: ${reason}`);
    } else if (paymentIntentId.startsWith("order_")) {
      // For Razorpay, we can only cancel an order if it's still pending
      try {
        const order = await razorpay.orders.fetchPayments(paymentIntentId);
        if (order.count === 0) {
          // No payments made yet, we can safely ignore
          console.log(`✅ Razorpay order had no payments, safe to ignore: ${paymentIntentId}`);
          return;
        }
        console.warn(`⚠️ Cannot cancel Razorpay order with existing payments: ${paymentIntentId}`);
      } catch (fetchError) {
        // If we can't fetch payments, assume it's safe to ignore
        console.log(`✅ Razorpay order fetch failed (likely safe to ignore): ${paymentIntentId}`);
        return;
      }
    } else {
      // For other payment gateways (LEMON_SQUEEZY, XFLOW), we'll need to implement
      console.warn(`⚠️ Payment intent cancellation not implemented for: ${paymentIntentId}`);
      return;
    }
  } catch (error) {
    console.error(`Failed to cancel payment intent ${paymentIntentId}:`, error);
    
    // Don't throw here - cancellation failure shouldn't break the main flow
    // This is a cleanup operation and should be best-effort
    if (error instanceof Error && error.message.includes("already_cancelled")) {
      console.log(`✅ Payment intent was already cancelled: ${paymentIntentId}`);
      return;
    }
    
    console.warn(`⚠️ Failed to cancel payment intent ${paymentIntentId}, but continuing...`);
  }
}

export async function initiateRefund(
  paymentIntentId: string,
  amount?: number,
): Promise<void> {
  try {
    if (paymentIntentId.startsWith("pi_")) {
      // Stripe refund
      await stripeClient.refunds.create({
        payment_intent: paymentIntentId,
        amount: amount ? Math.round(amount * 100) : undefined,
      });
    } else {
      // Razorpay refund
      const payments = await razorpay.orders.fetchPayments(paymentIntentId);
      if (payments.count > 0) {
        const payment = payments.items[0];
        await razorpay.payments.refund(payment.id, {
          amount: amount ? Math.round(amount * 100) : undefined,
        });
      } else {
        throw new Error("No payment found for refund");
      }
    }
  } catch (error) {
    console.error("Failed to initiate refund:", error);
    throw new Error("Failed to process refund");
  }
}

// Helper function to determine payment gateway from payment intent ID
export function getPaymentGateway(paymentIntentId: string): PaymentGateway {
  return paymentIntentId.startsWith("pi_") ? "STRIPE" : "RAZORPAY";
}

// Helper function to convert amount to smallest currency unit
export function convertAmountToSmallestUnit(
  amount: number,
  currency: string,
): number {
  const multipliers: { [key: string]: number } = {
    USD: 100, // cents
    EUR: 100, // cents
    GBP: 100, // pence
    JPY: 1, // yen has no smaller unit
    INR: 100, // paise
  };

  return Math.round(amount * (multipliers[currency] || 100));
}
