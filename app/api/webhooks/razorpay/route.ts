import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { PaymentStatus, RequestStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-razorpay-signature");

    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error("RAZORPAY_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    // Verify webhook signature
    if (signature) {
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("Razorpay webhook signature verification failed");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 },
        );
      }
    }

    const event = JSON.parse(body);

    // Log all webhook events
    console.log(`🔔 Razorpay Webhook Event: ${event.event}`, {
      account_id: event.account_id,
      entity: event.entity,
      created_at: new Date(event.created_at * 1000).toISOString(),
      payload: event.payload,
    });

    // Handle different event types
    switch (event.event) {
      case "payment.captured":
      case "order.paid":
        // Both events indicate successful payment
        const paymentEntity =
          event.payload.payment?.entity || event.payload.order?.entity;
        const orderId = paymentEntity.order_id || paymentEntity.id;

        console.log("✅ Razorpay payment successful:", {
          id: paymentEntity.id,
          order_id: orderId,
          amount: paymentEntity.amount,
          currency: paymentEntity.currency,
          status: paymentEntity.status,
        });

        try {
          // Find payment record by order_id (which we store as paymentIntent)
          const payment = await prisma.payment.findUnique({
            where: { paymentIntent: orderId },
            include: { user: { include: { consulteeProfile: true } } },
          });

          if (!payment) {
            console.error("Payment record not found for order:", orderId);
            break;
          }

          if (!payment.user.consulteeProfile) {
            console.error("User profile not found for payment:", payment.id);
            break;
          }

          // Update payment status
          await prisma.payment.update({
            where: { id: payment.id },
            data: { paymentStatus: PaymentStatus.SUCCEEDED },
          });

          // Create appointment from metadata if not exists
          if (!payment.appointmentId) {
            // For Razorpay, we need to get metadata from payment notes or reconstruct from stored data
            // Since Razorpay doesn't have built-in metadata like Stripe, we'll need to store
            // appointment details in the payment record or use notes
            console.log(
              "Creating appointment for Razorpay payment:",
              payment.id,
            );
            await createAppointmentFromPayment(payment);
          } else {
            // Confirm existing appointment
            await confirmExistingAppointment(payment.appointmentId);
          }

          console.log("✅ Razorpay payment processed successfully");
        } catch (error) {
          console.error("Failed to process Razorpay payment:", error);
        }
        break;

      case "payment.failed":
        const failedPayment = event.payload.payment.entity;
        const failedOrderId = failedPayment.order_id;

        console.log("❌ Razorpay payment failed:", {
          id: failedPayment.id,
          order_id: failedOrderId,
          error_code: failedPayment.error_code,
          error_description: failedPayment.error_description,
        });

        try {
          // Find and update payment record
          const payment = await prisma.payment.findUnique({
            where: { paymentIntent: failedOrderId },
            include: { appointment: true },
          });

          if (payment) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { paymentStatus: PaymentStatus.FAILED },
            });

            // Cleanup failed payment appointment if exists
            if (payment.appointment) {
              await cleanupFailedPaymentAppointment(payment.appointment.id);
            }
          }
        } catch (error) {
          console.error("Failed to process Razorpay payment failure:", error);
        }
        break;

      case "subscription.charged":
        const subscription = event.payload.subscription.entity;
        console.log("✅ Razorpay subscription charged:", {
          id: subscription.id,
          status: subscription.status,
          current_start: new Date(
            subscription.current_start * 1000,
          ).toISOString(),
          current_end: new Date(subscription.current_end * 1000).toISOString(),
        });
        // Handle subscription renewals if needed
        break;

      case "subscription.activated":
        const activatedSub = event.payload.subscription.entity;
        console.log("🆕 Razorpay subscription activated:", {
          id: activatedSub.id,
          status: activatedSub.status,
          plan_id: activatedSub.plan_id,
          customer_id: activatedSub.customer_id,
        });
        break;

      default:
        console.log(`📄 Unhandled Razorpay event type: ${event.event}`);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

// Helper function to create appointment from payment record
async function createAppointmentFromPayment(payment: any) {
  await prisma.$transaction(async (tx) => {
    // For Razorpay, we need to determine the appointment type and details
    // This might require storing additional data in the payment record
    // For now, we'll implement a basic version

    console.log(
      "Creating appointment for Razorpay payment - implementation needed",
    );

    // TODO: Implement appointment creation based on stored payment data
    // This would require storing appointment metadata in the payment record
    // or finding another way to reconstruct the booking details

    // For now, just log that this needs implementation
    console.warn(
      "Razorpay appointment creation needs implementation - metadata not available",
    );
  });
}

// Helper function to confirm existing appointment
async function confirmExistingAppointment(appointmentId: string) {
  await prisma.$transaction(async (tx) => {
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
  });
}

// Helper function to cleanup failed payment appointments
async function cleanupFailedPaymentAppointment(appointmentId: string) {
  await prisma.$transaction(async (tx) => {
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
  });
}
