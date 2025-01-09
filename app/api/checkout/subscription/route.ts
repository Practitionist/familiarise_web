import { createPaymentIntent } from "@/lib/payment";
import { PaymentStatus, RequestStatus } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { PaymentIntentParams, PaymentMetadata } from "@/types/checkout";
import { SubscriptionCheckoutSchema } from "@/schemas/checkout";
import prisma from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse and validate request body
    const body = await req.json();
    const validationResult = SubscriptionCheckoutSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request data",
          issues: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { subscriptionPlanId, slotIds, slotTimes, paymentGateway } =
      validationResult.data;

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
      const existingSlots = await tx.slotOfAppointment.findMany({
        where: {
          id: { in: slotIds },
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

      if (existingSlots.length > 0) {
        return NextResponse.json(
          { error: "One or more selected slots are no longer available" },
          { status: 409 },
        );
      }

      // 2. Get subscription plan
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: subscriptionPlanId },
      });

      if (!plan) {
        throw new Error("Subscription plan not found");
      }

      // 3. Create appointment
      const appointment = await tx.appointment.create({
        data: {
          appointmentType: "SUBSCRIPTION",
        },
      });

      // 4. Create tentative slots
      await Promise.all(
        slotIds.map((slotId, index) =>
          tx.slotOfAppointment.create({
            data: {
              id: slotId,
              slotStartTimeInUTC: new Date(slotTimes[index].slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(slotTimes[index].slotEndTimeInUTC),
              isTentative: true,
              user: { connect: { id: userId } },
              appointment: { connect: { id: appointment.id } },
            },
          }),
        ),
      );

      // 5. Create subscription
      await tx.subscription.create({
        data: {
          subscriptionPlanId,
          startDate: new Date(),
          endDate: new Date(
            Date.now() + plan.durationInMonths * 30 * 24 * 60 * 60 * 1000,
          ),
          requestStatus: RequestStatus.PENDING,
          requestedById: consulteeProfile.id,
          appointments: { connect: { id: appointment.id } },
        },
      });

      // 6. Create payment intent
      const paymentMetadata: PaymentMetadata = {
        appointmentId: appointment.id,
        appointmentType: "SUBSCRIPTION",
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
    console.error("Subscription checkout error:", error);
    return NextResponse.json(
      { error: "Failed to process subscription checkout" },
      { status: 500 },
    );
  }
}
