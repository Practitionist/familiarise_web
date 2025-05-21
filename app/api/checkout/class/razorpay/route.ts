import * as Sentry from "@sentry/nextjs";
import { createRazorpayOrder } from "../../../payments/razorpay/utils";
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

      // 5. Create Razorpay order with class features
      const order = await createRazorpayOrder({
        amount,
        metadata: {
          classId: classEntity.id,
          appointmentId: classEntity.appointment.id,
          features: getClassFeatures(plan).join(", "),
        },
      });

      // 6. Create payment record
      await createPaymentRecord(tx, {
        amount,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        userId: session.user.id,
        appointmentId: classEntity.appointment.id,
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
