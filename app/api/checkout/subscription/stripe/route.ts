import { createStripePaymentIntent } from "../../../payments/stripe/utils";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../../auth/[...nextauth]/options";
import { subscriptionCheckoutSchema } from "../schema";
import {
  validateAndGetPlan,
  calculateFinalAmount,
  createSubscriptionAppointment,
  createPaymentRecord,
  validateSubscriptionEligibility,
} from "../utils";

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = subscriptionCheckoutSchema.parse(body);

    // Start transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Get and validate subscription plan
      const plan = await validateAndGetPlan(tx, validatedData.subscriptionPlanId);

      // 2. Validate subscription eligibility
      await validateSubscriptionEligibility(
        tx,
        session.user.id,
        validatedData.subscriptionPlanId
      );

      // 3. Calculate final amount
      const { amount, discountCodeId } = await calculateFinalAmount(
        tx,
        plan.price,
        validatedData.discountCode
      );

      // 4. Create subscription and appointment
      const subscription = await createSubscriptionAppointment(tx, {
        subscriptionPlanId: plan.id,
        userId: session.user.id,
      });

      // 5. Create payment intent
      const paymentIntent = await createStripePaymentIntent({
        amount,
        metadata: {
          subscriptionId: subscription.id,
          appointmentId: subscription.appointment.id,
        },
      });

      // 6. Create payment record
      await createPaymentRecord(tx, {
        amount,
        currency: "USD",
        paymentGateway: "STRIPE",
        userId: session.user.id,
        appointmentId: subscription.appointment.id,
        discountCodeId,
        initialPaymentIntent: paymentIntent.id,
      });

      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
      });
    });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 }
    );
  }
}
