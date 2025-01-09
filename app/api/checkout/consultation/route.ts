import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
import { PaymentStatus, RequestStatus } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { PaymentIntentParams, PaymentMetadata } from "@/types/checkout";
import { ConsultationCheckoutSchema } from "@/schemas/checkout";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse and validate request body
    const body = await req.json();
    const validationResult = ConsultationCheckoutSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request data",
          issues: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const {
      consultationPlanId,
      slotId,
      slotStartTimeInUTC,
      slotEndTimeInUTC,
      paymentGateway,
    } = validationResult.data;

    // Get user with consultee profile
    const userWithProfile = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { consulteeProfile: true },
    });

    if (!userWithProfile) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!userWithProfile.consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const { id: userId, consulteeProfile } = userWithProfile;

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Validate slot availability
      const existingSlot = await tx.slotOfAppointment.findFirst({
        where: {
          id: slotId,
          OR: [
            { isTentative: false },
            {
              isTentative: true,
              appointment: {
                payment: {
                  some: {
                    paymentStatus: PaymentStatus.PENDING,
                    createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) },
                  },
                },
              },
            },
          ],
        },
      });

      if (existingSlot) {
        return NextResponse.json(
          { error: "Selected slot is no longer available" },
          { status: 409 },
        );
      }

      // 2. Create appointment
      const appointment = await tx.appointment.create({
        data: {
          appointmentType: "CONSULTATION",
        },
      });

      // 3. Create tentative slot
      await tx.slotOfAppointment.create({
        data: {
          id: slotId,
          slotStartTimeInUTC: new Date(slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(slotEndTimeInUTC),
          isTentative: true,
          user: { connect: { id: userId } },
          appointment: { connect: { id: appointment.id } },
        },
      });

      // 4. Create consultation
      await tx.consultation.create({
        data: {
          consultationPlanId,
          requestStatus: RequestStatus.PENDING,
          appointment: { connect: { id: appointment.id } },
          requestedById: consulteeProfile.id,
        },
      });

      // 5. Get plan details for payment
      const plan = await tx.consultationPlan.findUnique({
        where: { id: consultationPlanId },
      });

      if (!plan) {
        throw new Error("Consultation plan not found");
      }

      // 6. Create payment intent
      const paymentMetadata: PaymentMetadata = {
        appointmentId: appointment.id,
        appointmentType: "CONSULTATION",
        userId,
      };

      const paymentIntentParams: PaymentIntentParams = {
        amount: plan.price,
        currency: "USD",
        metadata: paymentMetadata,
        paymentGateway,
      };

      const paymentIntent = await createPaymentIntent(paymentIntentParams);

      // 7. Create payment record
      await tx.payment.create({
        data: {
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          paymentMethod: paymentGateway,
          paymentIntent: paymentIntent.id,
          paymentGateway,
          paymentStatus: PaymentStatus.PENDING,
          appointment: { connect: { id: appointment.id } },
          user: { connect: { id: userId } },
        },
      });

      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
        appointmentId: appointment.id,
      });
    });

    return result;
  } catch (error) {
    console.error("Consultation checkout error:", error);
    return NextResponse.json(
      { error: "Failed to process consultation checkout" },
      { status: 500 },
    );
  }
}
