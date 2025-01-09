import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { PaymentMetadata } from "@/types/checkout";

interface StripePaymentIntent {
  id: string;
  client_secret: string;
  status: string;
  metadata: Record<string, string>;
}

interface StripeMock {
  paymentIntents: {
    create: (params: {
      amount: number;
      currency: string;
      metadata: Record<string, string>;
      automatic_payment_methods: { enabled: boolean };
    }) => Promise<StripePaymentIntent>;
  };
}

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-12-18.acacia",
    })
  : ({
      paymentIntents: {
        create: async () => ({
          id: "mock_payment_intent_id",
          client_secret: "mock_client_secret",
          status: "succeeded",
          metadata: {},
        }),
      },
    } as StripeMock);

export async function POST(req: Request) {
  try {
    const { amount, currency, metadata } = await req.json();

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      metadata,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Stripe payment error:", error);
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 },
    );
  }
}
