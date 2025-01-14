import { createStripePaymentIntent } from "./utils";
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

    // Create payment intent
    const paymentIntent = await createStripePaymentIntent({
      amount: validatedData.amount,
      metadata: {
        consultationId: validatedData.metadata.consultationId,
        appointmentId: validatedData.metadata.appointmentId,
      },
    });

    // Update payment record with payment intent ID
    await prisma.payment.update({
      where: { id: validatedData.paymentId },
      data: { paymentIntent: paymentIntent.id },
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 },
    );
  }
}
