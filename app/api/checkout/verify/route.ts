import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import prisma from "@/lib/prisma";
import authOptions from "../../auth/[...nextauth]/options";

export async function GET(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get payment intent from query parameters
    const { searchParams } = new URL(req.url);
    const paymentIntent = searchParams.get("payment_intent");

    if (!paymentIntent) {
      return NextResponse.json(
        { error: "Payment intent ID is required" },
        { status: 400 },
      );
    }

    // Find payment record with appointment details
    const payment = await prisma.payment.findUnique({
      where: { paymentIntent },
      include: {
        user: true,
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: true,
                requestedBy: true,
              },
            },
            subscription: {
              include: {
                subscriptionPlan: true,
                requestedBy: true,
              },
            },
            webinar: {
              include: {
                webinarPlan: true,
              },
            },
            class: {
              include: {
                classPlan: true,
              },
            },
            slotsOfAppointment: true,
          },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Verify the payment belongs to the authenticated user
    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Unauthorized access to payment" },
        { status: 403 },
      );
    }

    // Check payment status
    if (payment.paymentStatus !== "SUCCEEDED") {
      return NextResponse.json(
        {
          error: "Payment not completed",
          status: payment.paymentStatus,
          message: getPaymentStatusMessage(payment.paymentStatus),
        },
        { status: 400 },
      );
    }

    // Get appointment type from appointment or metadata
    let appointmentType = "UNKNOWN";
    if (payment.appointment) {
      appointmentType = payment.appointment.appointmentType;
    }

    // Return success response with appointment details
    return NextResponse.json({
      paymentIntent: payment.paymentIntent,
      appointmentType,
      status: "SUCCEEDED",
      message: "Payment verified successfully",
      appointment: payment.appointment
        ? {
            id: payment.appointment.id,
            type: payment.appointment.appointmentType,
            slots: payment.appointment.slotsOfAppointment,
            consultation: payment.appointment.consultation,
            subscription: payment.appointment.subscription,
            webinar: payment.appointment.webinar,
            class: payment.appointment.class,
          }
        : null,
      amount: payment.amount,
      currency: payment.currency,
      createdAt: payment.createdAt,
    });
  } catch (error) {
    console.error("Payment verification error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

function getPaymentStatusMessage(status: string): string {
  switch (status) {
    case "PENDING":
      return "Payment is still being processed. Please wait a few moments and refresh the page.";
    case "FAILED":
      return "Payment failed. Please try again with a different payment method.";
    default:
      return "Payment status is unknown. Please contact support.";
  }
}
