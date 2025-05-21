import * as Sentry from "@sentry/nextjs";
import { createLemonSqueezyCheckout } from "../../../payments/lemon-squeezy/utils";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../../auth/[...nextauth]/options";
import { classCheckoutSchema } from "../schema";
import {
  validateAndGetPlan,
  calculateFinalAmount,
  createClassAppointment,
  createPaymentRecord,
  validateClassEligibility,
  getClassFeatures,
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
    const validatedData = classCheckoutSchema.parse(body);

    // Start transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Get and validate class plan
      const plan = await validateAndGetPlan(tx, validatedData.classPlanId);

      // 2. Validate class eligibility
      await validateClassEligibility(
        tx,
        session.user.id,
        validatedData.classPlanId,
      );

      // 3. Calculate final amount
      const { amount, discountCodeId } = await calculateFinalAmount(
        tx,
        plan.price,
        validatedData.discountCode,
      );

      // 4. Create class and appointment
      const classEntity = await createClassAppointment(tx, {
        classPlanId: plan.id,
        userId: session.user.id,
      });

      // 5. Create payment record first (Lemon Squeezy requires this)
      const payment = await createPaymentRecord(tx, {
        amount,
        currency: "USD",
        paymentGateway: "LEMON_SQUEEZY",
        userId: session.user.id,
        appointmentId: classEntity.appointment.id,
        discountCodeId,
      });

      // Get class features for product description
      const features = getClassFeatures(plan);

      // 6. Create Lemon Squeezy checkout
      const checkoutData = await createLemonSqueezyCheckout({
        amount,
        metadata: {
          payment_id: payment.id,
          class_id: classEntity.id,
          appointment_id: classEntity.appointment.id,
          user_id: session.user.id,
        },
        productDetails: {
          name: plan.title,
          description: plan.consultantProfile?.user?.name
            ? `${plan.durationInMonths} month class with ${plan.consultantProfile.user.name}\n\nFeatures:\n${features.join("\n")}`
            : `${plan.durationInMonths} month class\n\nFeatures:\n${features.join("\n")}`,
        },
        urls: {
          success: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`,
          cancel: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
        },
      });

      // 7. Update payment record with checkout ID
      await updatePaymentIntent(tx, payment.id, checkoutData.data.id);

      return NextResponse.json({
        checkoutUrl: checkoutData.data.attributes.url,
        checkoutId: checkoutData.data.id,
      });
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 },
    );
  }
}
