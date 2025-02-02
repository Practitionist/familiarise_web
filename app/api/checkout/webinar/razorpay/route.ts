import { createRazorpayOrder } from "../../../payments/razorpay/utils";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import authOptions from "../../../auth/[...nextauth]/options";
import { webinarCheckoutSchema } from "../schema";
import {
  validateAndGetPlan,
  calculateFinalAmount,
  createWebinarAppointment,
  createPaymentRecord,
  validateWebinarEligibility,
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
    const validatedData = webinarCheckoutSchema.parse(body);

    // Start transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Get and validate webinar plan
      const plan = await validateAndGetPlan(tx, validatedData.webinarPlanId);

      // 2. Validate webinar eligibility
      await validateWebinarEligibility(
        tx,
        session.user.id,
        validatedData.webinarPlanId,
      );

      // 3. Calculate final amount
      const { amount, discountCodeId } = await calculateFinalAmount(
        tx,
        plan.price,
        validatedData.discountCode,
      );

      // 4. Create webinar and appointment
      const webinar = await createWebinarAppointment(tx, {
        webinarPlanId: plan.id,
        userId: session.user.id,
      });

      // 5. Create Razorpay order
      const order = await createRazorpayOrder({
        amount,
        metadata: {
          webinarId: webinar.id,
          appointmentId: webinar.appointment.id,
        },
      });

      // 6. Create payment record
      await createPaymentRecord(tx, {
        amount,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        userId: session.user.id,
        appointmentId: webinar.appointment.id,
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
    console.error("Checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 },
    );
  }
}
