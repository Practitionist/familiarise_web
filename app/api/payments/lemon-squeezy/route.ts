import * as Sentry from "@sentry/nextjs";
import { createLemonSqueezyCheckout } from "./utils";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import authOptions from "../../auth/[...nextauth]/options";

// Validate request body
const checkoutSchema = z.object({
  paymentId: z.string(),
  amount: z.number(),
  metadata: z.object({
    consultationId: z.string(),
    appointmentId: z.string(),
    userId: z.string(),
    planTitle: z.string(),
    consultantName: z.string().optional(),
  }),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);

    // Get payment record
    const payment = await prisma.payment.findUnique({
      where: { id: validatedData.paymentId },
    });

    if (!payment) {
      return NextResponse.json(
        { error: "Payment record not found" },
        { status: 404 },
      );
    }

    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Payment record does not belong to user" },
        { status: 403 },
      );
    }

    // Create Lemon Squeezy checkout
    const data = await createLemonSqueezyCheckout({
      amount: validatedData.amount,
      metadata: {
        payment_id: validatedData.paymentId,
        user_id: validatedData.metadata.userId,
        appointment_id: validatedData.metadata.appointmentId,
        consultation_id: validatedData.metadata.consultationId,
      },
      productDetails: {
        name: validatedData.metadata.planTitle,
        description: validatedData.metadata.consultantName
          ? `Consultation with ${validatedData.metadata.consultantName}`
          : "Consultation",
      },
      urls: {
        success: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/success`,
        cancel: `${process.env.NEXT_PUBLIC_APP_URL}/checkout/cancel`,
      },
    });

    // Update payment record with checkout ID
    await prisma.payment.update({
      where: { id: validatedData.paymentId },
      data: { paymentIntent: data.data.id },
    });

    return NextResponse.json({
      checkoutUrl: data.data.attributes.url,
      checkoutId: data.data.id,
    });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Lemon Squeezy checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 },
    );
  }
}
