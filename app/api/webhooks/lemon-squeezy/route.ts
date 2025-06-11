import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { PaymentStatus, RequestStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-signature");

    if (!process.env.LEMON_SQUEEZY_WEBHOOK_SECRET) {
      console.error("LEMON_SQUEEZY_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    // Verify webhook signature for Lemon Squeezy
    if (signature) {
      const expectedSignature = crypto
        .createHmac("sha256", process.env.LEMON_SQUEEZY_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      if (signature !== `sha256=${expectedSignature}`) {
        console.error("Lemon Squeezy webhook signature verification failed");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 },
        );
      }
    }

    const event = JSON.parse(body);

    // Log webhook events
    console.log(`🍋 Lemon Squeezy Webhook Event: ${event.meta?.event_name}`, {
      event_name: event.meta?.event_name,
      webhook_id: event.meta?.webhook_id,
      custom_data: event.meta?.custom_data,
    });

    // Handle different event types
    switch (event.meta?.event_name) {
      case "order_created":
        const order = event.data;
        console.log("🍋 Order created:", {
          id: order.id,
          identifier: order.attributes.identifier,
          total: order.attributes.total,
          status: order.attributes.status,
          customer_id: order.attributes.customer_id,
        });

        if (order.attributes.status === "paid") {
          await handleLemonSqueezyPaymentSuccess(
            order.attributes.identifier,
            order.attributes.user_email,
          );
        }
        break;

      case "subscription_created":
        const subscription = event.data;
        console.log("🍋 Subscription created:", {
          id: subscription.id,
          status: subscription.attributes.status,
          customer_id: subscription.attributes.customer_id,
          variant_id: subscription.attributes.variant_id,
        });

        if (subscription.attributes.status === "active") {
          await handleLemonSqueezyPaymentSuccess(
            subscription.id.toString(),
            subscription.attributes.user_email,
          );
        }
        break;

      case "subscription_payment_success":
        const successfulPayment = event.data;
        console.log("🍋 Subscription payment successful:", {
          id: successfulPayment.id,
          subscription_id: successfulPayment.attributes.subscription_id,
          amount: successfulPayment.attributes.total,
        });

        await handleLemonSqueezyPaymentSuccess(
          successfulPayment.attributes.subscription_id.toString(),
          successfulPayment.attributes.user_email,
        );
        break;

      case "subscription_payment_failed":
        const failedPayment = event.data;
        console.log("🍋 Subscription payment failed:", {
          id: failedPayment.id,
          subscription_id: failedPayment.attributes.subscription_id,
          failure_reason: failedPayment.attributes.failure_reason,
        });

        await handleLemonSqueezyPaymentFailure(
          failedPayment.attributes.subscription_id.toString(),
        );
        break;

      case "subscription_cancelled":
        const cancelledSub = event.data;
        console.log("🍋 Subscription cancelled:", {
          id: cancelledSub.id,
          status: cancelledSub.attributes.status,
        });
        // Handle subscription cancellation if needed
        break;

      default:
        console.log(
          `🍋 Unhandled Lemon Squeezy event type: ${event.meta?.event_name}`,
        );
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Lemon Squeezy webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

// Helper function to handle successful Lemon Squeezy payments
async function handleLemonSqueezyPaymentSuccess(
  paymentIdentifier: string,
  userEmail?: string,
) {
  await prisma.$transaction(async (tx) => {
    // Find payment record by identifier (stored as paymentIntent)
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIdentifier },
      include: {
        user: { include: { consulteeProfile: true } },
        appointment: {
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
          },
        },
      },
    });

    if (!payment) {
      console.error(
        "Payment record not found for identifier:",
        paymentIdentifier,
      );
      return;
    }

    if (!payment.user.consulteeProfile) {
      console.error("User profile not found for payment:", payment.id);
      return;
    }

    // Update payment status
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        receiptUrl: userEmail ? `receipt_${userEmail}` : undefined,
      },
    });

    // Create appointment from metadata if not exists
    if (!payment.appointmentId) {
      console.log(
        "Creating appointment for Lemon Squeezy payment:",
        payment.id,
      );
      await createAppointmentFromPayment(tx, payment);
    } else {
      // Confirm existing appointment
      await confirmExistingAppointment(tx, payment.appointmentId);
    }

    console.log("✅ Lemon Squeezy payment processed successfully");
  });
}

// Helper function to handle failed Lemon Squeezy payments
async function handleLemonSqueezyPaymentFailure(paymentIdentifier: string) {
  await prisma.$transaction(async (tx) => {
    // Find and update payment record
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIdentifier },
      include: { appointment: true },
    });

    if (!payment) {
      console.warn(`Payment not found for identifier: ${paymentIdentifier}`);
      return;
    }

    // Update payment status
    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    // Cleanup failed payment appointment if exists
    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    console.log(`Processed Lemon Squeezy payment failure: ${payment.id}`);
  });
}

// Helper function to create appointment from payment record
async function createAppointmentFromPayment(tx: any, payment: any) {
  // For Lemon Squeezy, like Razorpay, we need to store appointment metadata
  // in the payment record or use custom_data from the webhook
  console.log(
    "Creating appointment for Lemon Squeezy payment - implementation needed",
  );

  // TODO: Implement appointment creation based on stored payment data
  // This would require storing appointment metadata in the payment record
  // or using Lemon Squeezy's custom_data field

  console.warn(
    "Lemon Squeezy appointment creation needs implementation - metadata not available",
  );
}

// Helper function to confirm existing appointment
async function confirmExistingAppointment(tx: any, appointmentId: string) {
  // Make slots non-tentative
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  // Update appointment status
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (appointment?.consultation) {
    await tx.consultation.update({
      where: { id: appointment.consultation.id },
      data: { requestStatus: RequestStatus.PENDING }, // Keep as PENDING for consultant approval
    });
  }

  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.PENDING }, // Keep as PENDING for consultant approval
    });
  }

  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: "SCHEDULED" },
    });
  }

  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: "SCHEDULED" },
    });
  }
}

// Helper function to cleanup failed payment appointments
async function cleanupFailedPaymentAppointment(tx: any, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (!appointment) return;

  // Delete associated records
  if (appointment.consultation) {
    await tx.consultation.delete({
      where: { id: appointment.consultation.id },
    });
  }

  if (appointment.subscription) {
    await tx.subscription.delete({
      where: { id: appointment.subscription.id },
    });
  }

  // Delete slots and appointment
  await tx.slotOfAppointment.deleteMany({
    where: { appointmentId },
  });

  await tx.appointment.delete({
    where: { id: appointmentId },
  });

  console.log(`Cleaned up failed payment appointment: ${appointmentId}`);
}
