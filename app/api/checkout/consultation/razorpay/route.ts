import * as Sentry from "@sentry/nextjs";
import { createRazorpayOrder } from "../../../payments/razorpay/utils";
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

      // 5. Create Razorpay order
      const order = await createRazorpayOrder({
        amount,
        metadata: {
          consultationId: consultation.id,
          appointmentId: consultation.appointment.id,
        },
      });

      // 6. Create payment record
      await createPaymentRecord(tx, {
        amount,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        userId: session.user.id,
        appointmentId: consultation.appointment.id,
        discountCodeId,
        initialPaymentIntent: order.id,
      });

      return NextResponse.json({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
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
