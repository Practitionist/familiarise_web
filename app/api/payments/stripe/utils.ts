import Stripe from "stripe";

export interface StripePaymentIntent {
  id: string;
  client_secret: string;
  status: string;
  metadata: Record<string, string>;
}

export interface StripeMock {
  paymentIntents: {
    create: (params: {
      amount: number;
      currency: string;
      metadata: Record<string, string>;
      automatic_payment_methods: { enabled: boolean };
    }) => Promise<StripePaymentIntent>;
    cancel: (paymentIntentId: string) => Promise<StripePaymentIntent>;
  };
  webhooks: {
    constructEvent: (
      body: string,
      signature: string,
      secret: string,
    ) => { type: string; data: { object: any } };
  };
  refunds: {
    create: (params: {
      payment_intent: string;
      amount?: number;
    }) => Promise<{ id: string }>;
  };
}

// Mock implementations for testing
const mockStripe: StripeMock = {
  paymentIntents: {
    create: async () => ({
      id: "mock_payment_intent_id",
      client_secret: "mock_client_secret",
      status: "succeeded",
      metadata: {},
    }),
    cancel: async () => ({
      id: "mock_payment_intent_id",
      client_secret: "mock_client_secret",
      status: "canceled",
      metadata: {},
    }),
  },
  webhooks: {
    constructEvent: () => ({
      type: "payment_intent.succeeded",
      data: { object: { metadata: {} } },
    }),
  },
  refunds: {
    create: async () => ({ id: "mock_refund_id" }),
  },
};

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-01-27.acacia",
    })
  : mockStripe;

// Helper function to verify Stripe webhook signature
export function verifyStripeWebhook(
  body: string,
  signature: string,
  secret: string,
) {
  return stripe.webhooks.constructEvent(body, signature, secret);
}

// Helper function to convert amount to cents
export function convertAmountToCents(amount: number): number {
  return Math.round(amount * 100);
}

// Helper function to create payment intent
export async function createStripePaymentIntent({
  amount,
  metadata,
}: {
  amount: number;
  metadata: Record<string, string>;
}) {
  return stripe.paymentIntents.create({
    amount: convertAmountToCents(amount),
    currency: "usd",
    metadata,
    automatic_payment_methods: {
      enabled: true,
    },
  });
}

// Helper function to cancel payment intent
export async function cancelStripePaymentIntent(paymentIntentId: string) {
  return stripe.paymentIntents.cancel(paymentIntentId);
}

// Helper function to create refund
export async function createStripeRefund(
  paymentIntentId: string,
  amount?: number,
) {
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: amount ? convertAmountToCents(amount) : undefined,
  });
}
