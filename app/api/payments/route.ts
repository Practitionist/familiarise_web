import * as Sentry from "@sentry/nextjs";
import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import authOptions from "../auth/[...nextauth]/options";
import { PaymentIntentParams, PaymentMetadata } from "@/types/checkout";

type TransactionClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      appointmentType,
      planId,
      slotIds,
      paymentGateway = "STRIPE",
    } = await req.json();

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

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
          { error: "Selected slots are no longer available" },
          { status: 409 },
        );
      }

      // 2. Create appointment first
      const appointment = await tx.appointment.create({
        data: {
          appointmentType,
        },
      });

      // 3. Create tentative appointment slots
      const appointmentSlots = await Promise.all(
        slotIds.map((slotId: string) =>
          tx.slotOfAppointment.create({
            data: {
              slotStartTimeInUTC: new Date(), // This should come from request
              slotEndTimeInUTC: new Date(), // This should come from request
              isTentative: true,
              user: { connect: { id: user.id } },
              appointment: { connect: { id: appointment.id } },
            },
          }),
        ),
      );

      // 4. Handle specific appointment type logic
      switch (appointmentType) {
        case "CONSULTATION":
          await handleConsultationBooking(tx, appointment.id, planId, user.id);
          break;
        case "SUBSCRIPTION":
          await handleSubscriptionBooking(tx, appointment.id, planId, user.id);
          break;
        case "WEBINAR":
          await handleWebinarBooking(tx, appointment.id, planId);
          break;
        case "CLASS":
          await handleClassBooking(tx, appointment.id, planId);
          break;
      }

      // 5. Create payment intent
      const paymentMetadata: PaymentMetadata = {
        appointmentId: appointment.id,
        appointmentType,
        userId: user.id,
      };

      const paymentIntentParams: PaymentIntentParams = {
        amount: await calculateAmount(tx, appointmentType, planId),
        currency: "USD",
        metadata: paymentMetadata,
        paymentGateway,
      };

      const paymentIntent = await createPaymentIntent(paymentIntentParams);

      // 6. Create payment record
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
    Sentry.captureException(error);
    console.error("Checkout error:", error);
    return NextResponse.json(
      { error: "Failed to process checkout" },
      { status: 500 },
    );
  }
}

// Helper functions for specific appointment types
async function handleConsultationBooking(
  tx: TransactionClient,
  appointmentId: string,
  consultationPlanId: string,
  userId: string,
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { consulteeProfile: true },
  });

  if (!user?.consulteeProfile) {
    throw new Error("Consultee profile not found");
  }

  await tx.consultation.create({
    data: {
      consultationPlanId,
      requestStatus: RequestStatus.PENDING,
      appointment: { connect: { id: appointmentId } },
      requestedById: user.consulteeProfile.id,
    },
  });
}

async function handleSubscriptionBooking(
  tx: TransactionClient,
  appointmentId: string,
  subscriptionPlanId: string,
  userId: string,
) {
  const [plan, user] = await Promise.all([
    tx.subscriptionPlan.findUnique({
      where: { id: subscriptionPlanId },
    }),
    tx.user.findUnique({
      where: { id: userId },
      include: { consulteeProfile: true },
    }),
  ]);

  if (!user?.consulteeProfile) {
    throw new Error("Consultee profile not found");
  }

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  await tx.subscription.create({
    data: {
      subscriptionPlanId,
      startDate: new Date(),
      endDate: new Date(
        Date.now() + plan.durationInMonths * 30 * 24 * 60 * 60 * 1000,
      ),
      requestStatus: RequestStatus.PENDING,
      requestedById: user.consulteeProfile.id,
      appointments: { connect: { id: appointmentId } },
    },
  });
}

async function handleWebinarBooking(
  tx: TransactionClient,
  appointmentId: string,
  webinarId: string,
) {
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
    throw new Error("Webinar or webinar plan not found");
  }

  const currentParticipants = webinar.appointment ? 1 : 0;

  if (currentParticipants >= webinar.webinarPlan.maxParticipants) {
    throw new Error("CAPACITY_EXCEEDED");
  }

  await tx.webinar.update({
    where: { id: webinarId },
    data: {
      appointment: { connect: { id: appointmentId } },
    },
  });
}

async function handleClassBooking(
  tx: TransactionClient,
  appointmentId: string,
  classId: string,
) {
  const classEntity = await tx.class.findUnique({
    where: { id: classId },
    include: {
      classPlan: true,
      appointments: {
        include: {
          payment: {
            where: { paymentStatus: PaymentStatus.SUCCEEDED },
          },
        },
      },
    },
  });

  if (!classEntity || !classEntity.classPlan) {
    throw new Error("Class or class plan not found");
  }

  const currentParticipants = classEntity.appointments.length;

  if (currentParticipants >= classEntity.classPlan.maxParticipants) {
    throw new Error("CAPACITY_EXCEEDED");
  }

  await tx.class.update({
    where: { id: classId },
    data: {
      appointments: { connect: { id: appointmentId } },
    },
  });
}

async function calculateAmount(
  tx: TransactionClient,
  appointmentType: AppointmentsType,
  planId: string,
): Promise<number> {
  let plan;
  switch (appointmentType) {
    case "CONSULTATION":
      plan = await tx.consultationPlan.findUnique({ where: { id: planId } });
      break;
    case "SUBSCRIPTION":
      plan = await tx.subscriptionPlan.findUnique({ where: { id: planId } });
      break;
    case "WEBINAR":
      plan = await tx.webinarPlan.findUnique({ where: { id: planId } });
      break;
    case "CLASS":
      plan = await tx.classPlan.findUnique({ where: { id: planId } });
      break;
  }

  if (!plan) {
    throw new Error("Plan not found");
  }

  return plan.price;
}
