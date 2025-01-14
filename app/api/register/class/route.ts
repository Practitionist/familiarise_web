import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { PaymentIntentParams, PaymentMetadata } from "@/types/checkout";
import { ClassCheckoutSchema } from "@/schemas/checkout";

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse and validate request body
    const body = await req.json();
    const validationResult = ClassCheckoutSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request data",
          issues: validationResult.error.issues,
        },
        { status: 400 },
      );
    }

    const { classId, paymentGateway } = validationResult.data;

    // Get user
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Get class and check capacity
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
        return NextResponse.json({ error: "Class not found" }, { status: 404 });
      }

      // Check if class has started
      if (classEntity.startDate && classEntity.startDate < new Date()) {
        return NextResponse.json(
          { error: "Class has already started" },
          { status: 409 },
        );
      }

      const currentParticipants = classEntity.appointments.length;

      if (currentParticipants >= classEntity.classPlan.maxParticipants) {
        // Add to waitlist
        await tx.waitlist.create({
          data: {
            user: { connect: { id: user.id } },
            class: { connect: { id: classId } },
          },
        });

        return NextResponse.json(
          { error: "Class is full", status: "WAITLISTED" },
          { status: 409 },
        );
      }

      // 2. Create appointment
      const appointment = await tx.appointment.create({
        data: {
          appointmentType: "CLASS",
          class: { connect: { id: classId } },
        },
      });

      // 3. Create payment intent
      const paymentMetadata: PaymentMetadata = {
        appointmentId: appointment.id,
        appointmentType: "CLASS",
        userId: user.id,
      };

      const paymentIntentParams: PaymentIntentParams = {
        amount: classEntity.classPlan.price,
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

      // 5. Add user to class appointments
      await tx.class.update({
        where: { id: classId },
        data: {
          appointments: {
            connect: { id: appointment.id },
          },
        },
      });

      return NextResponse.json({
        clientSecret: paymentIntent.client_secret,
        appointmentId: appointment.id,
      });
    });

    return result;
  } catch (error) {
    console.error("Class checkout error:", error);
    return NextResponse.json(
      { error: "Failed to process class checkout" },
      { status: 500 },
    );
  }
}
