import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { PaymentIntentParams, PaymentMetadata } from "@/types/checkout";
import { WebinarCheckoutSchema } from "@/schemas/checkout";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse and validate request body
    const body = await req.json();
    const validationResult = WebinarCheckoutSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request data",
          issues: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { webinarId, paymentGateway } = validationResult.data;

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Get webinar and check capacity
      const webinar = await tx.webinar.findUnique({
        where: { id: webinarId },
        include: {
          webinarPlan: true,
          appointment: {
            include: {
              payment: {
                where: { paymentStatus: PaymentStatus.SUCCEEDED },
              },
            },
          },
        },
      });

      if (!webinar || !webinar.webinarPlan) {
        return NextResponse.json(
          { error: "Webinar not found" },
          { status: 404 },
        );
      }

      const currentParticipants = webinar.appointment ? 1 : 0;

      if (currentParticipants >= webinar.webinarPlan.maxParticipants) {
        // Add to waitlist
        await tx.waitlist.create({
          data: {
            user: { connect: { id: user.id } },
            webinar: { connect: { id: webinarId } },
          },
        });

        return NextResponse.json(
          { error: "Webinar is full", status: "WAITLISTED" },
          { status: 409 },
        );
      }

      // 2. Create appointment
      const appointment = await tx.appointment.create({
        data: {
          appointmentType: "WEBINAR",
          webinar: { connect: { id: webinarId } },
        },
      });

      // 3. Create payment intent
      const paymentMetadata: PaymentMetadata = {
        appointmentId: appointment.id,
        appointmentType: "WEBINAR",
        userId: user.id,
      };

      const paymentIntentParams: PaymentIntentParams = {
        amount: webinar.webinarPlan.price,
        currency: "USD",
        metadata: paymentMetadata,
        paymentGateway,
      };

      const paymentIntent = await createPaymentIntent(paymentIntentParams);

      // 4. Create payment record
      await tx.payment.create({
        data: {
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          paymentMethod: paymentGateway,
          paymentIntent: paymentIntent.id,
          paymentGateway,
          paymentStatus: PaymentStatus.PENDING,
          appointment: { connect: { id: appointment.id } },
          user: { connect: { id: user.id } },
        },
      });

      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
        appointmentId: appointment.id,
      });
    });

    return result;
  } catch (error) {
    console.error("Webinar checkout error:", error);
    return NextResponse.json(
      { error: "Failed to process webinar checkout" },
      { status: 500 },
    );
  }
}
