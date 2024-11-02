import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import Razorpay from "razorpay";
import crypto from "crypto";

const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : ({
        orders: {
          create: async () => ({
            id: "mock_order_id",
            amount: 1000,
            currency: "INR",
            receipt: "mock_receipt",
            status: "created",
          }),
        },
        payments: {
          fetch: async () => ({
            id: "mock_payment_id",
            status: "captured",
            acquirer_data: {
              rrn: "mock_rrn_receipt",
            },
          }),
        },
      } as unknown as Razorpay);

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

    // Create an order with Razorpay
    const order = await razorpay.orders.create({
      amount: amount * 100, // Razorpay expects amount in paise
      currency: "INR", // Change this if you support other currencies
      receipt: appointmentId,
      notes: {
        appointmentId,
        userId,
        description,
      },
    });

    // Create a payment record in the database
    const payment = await prisma.payment.create({
      data: {
        amount: amount,
        currency: "INR",
        description: description,
        paymentMethod: "RAZORPAY",
        paymentGateway: "RAZORPAY",
        paymentIntent: order.id,
        paymentStatus: "PENDING",
        user: { connect: { id: userId } },
        appointment: { connect: { id: appointmentId } },
      },
    });

    return NextResponse.json({
      orderId: order.id,
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
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      paymentId,
    } = body;

    // Mock signature verification when in development
    if (process.env.RAZORPAY_KEY_SECRET) {
      const generated_signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      if (generated_signature !== razorpay_signature) {
        return NextResponse.json(
          { error: "Invalid payment signature" },
          { status: 400 },
        );
      }
    }

    // Fetch payment details from Razorpay
    const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);

    // Update the payment record in the database
    const updatedPayment = await prisma.payment.update({
      where: { id: paymentId },
      data: {
        paymentStatus:
          paymentDetails.status === "captured" ? "SUCCEEDED" : "FAILED",
        receiptUrl: paymentDetails.acquirer_data?.rrn || null, // Using rrn as receipt URL, adjust if needed
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
