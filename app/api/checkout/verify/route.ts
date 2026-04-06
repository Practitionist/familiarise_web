import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { razorpayClient } from "@/lib/payments/core/razorpay";

export async function GET(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get payment intent from query parameters
    const { searchParams } = new URL(req.url);
    const paymentIntent = searchParams.get("payment_intent");
    // L4 FIX: Optional sync=true to fetch latest status from Razorpay
    const shouldSync = searchParams.get("sync") === "true";

    if (!paymentIntent) {
      return NextResponse.json(
        { error: "Payment intent ID is required" },
        { status: 400 },
      );
    }

    // If sync requested and this is a Razorpay order, fetch latest status
    if (shouldSync && paymentIntent.startsWith("order_") && razorpayClient) {
      try {
        const rzpOrder = await razorpayClient.orders.fetch(paymentIntent);
        if (rzpOrder.status === "paid") {
          // Update our DB if still PENDING
          await prisma.payment.updateMany({
            where: {
              paymentIntent,
              paymentStatus: "PENDING",
            },
            data: {
              paymentStatus: "SUCCEEDED",
              description: "Synced from Razorpay API (on-demand)",
            },
          });
        }
      } catch (syncError) {
        console.warn(
          `Failed to sync payment status from Razorpay for ${paymentIntent}:`,
          syncError,
        );
      }
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
    case "EXPIRED":
      return "Payment session expired. Please start a new checkout.";
    default:
      return "Payment status is unknown. Please contact support.";
  }
}
