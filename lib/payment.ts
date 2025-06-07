import Stripe from "stripe";
import Razorpay from "razorpay";
import { PaymentGateway } from "@prisma/client";
import crypto from "crypto";

// Initialize payment clients
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
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
      const intent = await stripe.paymentIntents.create({
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
    throw new Error("Failed to create payment intent");
  }
}

export async function validatePaymentWebhook(
  req: Request,
): Promise<{ type: string; metadata: Record<string, string> }> {
  const signature =
    req.headers.get("stripe-signature") ||
    req.headers.get("x-razorpay-signature");

  if (!signature) {
    throw new Error("No signature found in webhook request");
  }

  const body = await req.text();

  try {
    if (req.headers.get("stripe-signature")) {
      const event = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );

      if ("metadata" in event.data.object) {
        return {
          type: event.type,
          metadata: event.data.object.metadata as Record<string, string>,
        };
      }
      throw new Error("No metadata found in Stripe event");
    } else {
      // Validate Razorpay signature
      const shasum = crypto.createHmac(
        "sha256",
        process.env.RAZORPAY_WEBHOOK_SECRET!,
      );
      shasum.update(body);
      const digest = shasum.digest("hex");

      if (digest !== signature) {
        throw new Error("Invalid Razorpay signature");
      }

      const event = JSON.parse(body);
      return {
        type: event.event,
        metadata: event.payload.payment.entity.notes,
      };
    }
  } catch (error) {
    console.error("Webhook validation failed:", error);
    throw new Error("Invalid webhook signature");
  }
}

export async function cancelPaymentIntent(
  paymentIntentId: string,
): Promise<void> {
  try {
    if (paymentIntentId.startsWith("pi_")) {
      // Stripe payment intent
      await stripe.paymentIntents.cancel(paymentIntentId);
    } else {
      // For Razorpay, we can only cancel an order if it's still pending
      const order = await razorpay.orders.fetchPayments(paymentIntentId);
      if (order.count === 0) {
        // No payments made yet, we can safely ignore
        return;
      }
      throw new Error("Cannot cancel Razorpay payment after initiation");
    }
  } catch (error) {
    console.error("Failed to cancel payment intent:", error);
    throw new Error("Failed to cancel payment");
  }
}

export async function initiateRefund(
  paymentIntentId: string,
  amount?: number,
): Promise<void> {
  try {
    if (paymentIntentId.startsWith("pi_")) {
      // Stripe refund
      await stripe.refunds.create({
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

// Simple Razorpay webhook verification helper for backward compatibility
export function verifyRazorpayWebhook(
  body: string,
  signature: string,
  secret: string
): boolean {
  try {
    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(body);
    const digest = shasum.digest("hex");
    return digest === signature;
  } catch (error) {
    console.error("Razorpay webhook verification failed:", error);
    return false;
  }
}
