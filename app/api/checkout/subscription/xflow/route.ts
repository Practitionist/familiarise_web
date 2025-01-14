import { createXflowCheckoutSession } from "../../../payments/xflow/utils";
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
  updatePaymentIntent,
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

      // 5. Create payment record first (Xflow requires this)
      const payment = await createPaymentRecord(tx, {
        amount,
        currency: "USD",
        paymentGateway: "XFLOW",
        userId: session.user.id,
        appointmentId: subscription.appointment.id,
        discountCodeId,
      });

      // 6. Create Xflow checkout session
      const sessionData = await createXflowCheckoutSession({
        amount,
        metadata: {
          payment_id: payment.id,
          subscription_id: subscription.id,
          appointment_id: subscription.appointment.id,
          user_id: session.user.id,
        },
        customer: {
          id: session.user.id,
          email: session.user.email!,
        },
        productDetails: {
          name: plan.title,
          description: plan.consultantProfile.user?.name
            ? `${plan.durationInMonths} month subscription with ${plan.consultantProfile.user.name}`
            : `${plan.durationInMonths} month subscription`,
        },
        urls: {
          success: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
        },
      });

      // 7. Update payment record with session ID
      await updatePaymentIntent(tx, payment.id, sessionData.id);

      return NextResponse.json({
        checkoutUrl: sessionData.url,
        sessionId: sessionData.id,
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
