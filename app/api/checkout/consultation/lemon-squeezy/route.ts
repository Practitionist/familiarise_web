import * as Sentry from "@sentry/nextjs";
import { createLemonSqueezyCheckout } from "../../../payments/lemon-squeezy/utils";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../../auth/[...nextauth]/options";
import { consultationCheckoutSchema } from "../schema";
import {
  validateAndGetPlan,
  validateSlotAvailability,
  calculateFinalAmount,
  createConsultationAppointment,
  createPaymentRecord,
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
    const validatedData = consultationCheckoutSchema.parse(body);

    // Start transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Get and validate consultation plan
      const plan = await validateAndGetPlan(
        tx,
        validatedData.consultationPlanId,
      );

      // 2. Validate slot availability
      await validateSlotAvailability(tx, validatedData);

      // 3. Calculate final amount
      const { amount, discountCodeId } = await calculateFinalAmount(
        tx,
        plan.price,
        validatedData.discountCode,
      );

      // 4. Create consultation and appointment
      const consultation = await createConsultationAppointment(tx, {
        consultationPlanId: plan.id,
        userId: session.user.id,
        slotStartTimeInUTC: validatedData.slotStartTimeInUTC,
        slotEndTimeInUTC: validatedData.slotEndTimeInUTC,
      });

      // 5. Create payment record first (Lemon Squeezy requires this)
      const payment = await createPaymentRecord(tx, {
        amount,
        currency: "USD",
        paymentGateway: "LEMON_SQUEEZY",
        userId: session.user.id,
        appointmentId: consultation.appointment.id,
        discountCodeId,
      });

      // 6. Create Lemon Squeezy checkout
      const checkoutData = await createLemonSqueezyCheckout({
        amount,
        metadata: {
          payment_id: payment.id,
          consultation_id: consultation.id,
          appointment_id: consultation.appointment.id,
          user_id: session.user.id,
        },
        productDetails: {
          name: plan.title,
          description: plan.consultantProfile.user?.name
            ? `Consultation with ${plan.consultantProfile.user.name}`
            : "Consultation",
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
