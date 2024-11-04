import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-10-28.acacia",
    })
  : ({
      paymentIntents: {
        create: async () => ({
          id: "mock_payment_intent_id",
          client_secret: "mock_client_secret",
          status: "succeeded",
        }),
        retrieve: async () => ({
          id: "mock_payment_intent_id",
          status: "succeeded",
          receipt_email: "mock_receipt@example.com",
        }),
      },
    } as unknown as Stripe);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { appointmentId, userId } = body;

    // Fetch the appointment and related data
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: { include: { consultationPlan: true } },
        subscription: { include: { plan: true } },
        webinar: { include: { webinarPlan: true } },
        class: { include: { classPlan: true } },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Determine the amount to charge based on the appointment type
    let amount = 0;
    let description = "";
    if (appointment.consultation) {
      amount = appointment.consultation.consultationPlan.price;
      description = `Payment for Consultation: ${appointment.consultation.consultationPlan.title}`;
    } else if (appointment.subscription) {
      amount = appointment.subscription.plan.price;
      description = `Payment for Subscription: ${appointment.subscription.plan.title}`;
    } else if (appointment.webinar) {
      amount = appointment.webinar.webinarPlan.price;
      description = `Payment for Webinar: ${appointment.webinar.webinarPlan.title}`;
    } else if (appointment.class) {
      amount = appointment.class.classPlan.price;
      description = `Payment for Class: ${appointment.class.classPlan.title}`;
    }

    // Create a PaymentIntent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // Stripe expects amount in cents
      currency: "usd", // Change this if you support other currencies
      description: description,
      metadata: { appointmentId, userId },
    });

    // Create a payment record in the database
    const payment = await prisma.payment.create({
      data: {
        amount: amount,
        currency: "USD",
        description: description,
        paymentMethod: "STRIPE",
        paymentGateway: "STRIPE",
        paymentIntent: paymentIntent.id,
        paymentStatus: "PENDING",
        user: { connect: { id: userId } },
        appointment: { connect: { id: appointmentId } },
      },
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentId: payment.id,
    });
  } catch (error) {
    console.error("Error processing payment:", error);
    return NextResponse.json(
      { error: "An error occurred while processing the payment" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { paymentIntentId, paymentId } = body;

    // Retrieve the PaymentIntent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Update the payment record in the database
    const updatedPayment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        paymentStatus:
          paymentIntent.status === "succeeded" ? "SUCCEEDED" : "FAILED",
        receiptUrl: paymentIntent.receipt_email, // TODO: fix this
      },
    });

    return NextResponse.json({ payment: updatedPayment });
  } catch (error) {
    console.error("Error updating payment status:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the payment status" },
      { status: 500 },
    );
  }
}
