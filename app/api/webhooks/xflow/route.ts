import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { Prisma, PaymentStatus, RequestStatus } from "@prisma/client";
import { isDbHealthy } from "@/app/api/webhooks/utils";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("x-xflow-signature");

    if (!process.env.XFLOW_WEBHOOK_SECRET) {
      console.error("XFLOW_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    // Verify webhook signature for XFlow
    if (signature) {
      const expectedSignature = crypto
        .createHmac("sha256", process.env.XFLOW_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      if (signature !== expectedSignature) {
        console.error("XFlow webhook signature verification failed");
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 },
        );
      }
    }

    // DB health check — return 503 if DB is unreachable so XFlow retries
    if (!(await isDbHealthy())) {
      console.warn("[xflow webhook] DB unhealthy — returning 503 for retry");
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      );
    }

    const event = JSON.parse(body);

    // Log webhook events
    console.log(`🌊 XFlow Webhook Event: ${event.type}`, {
      type: event.type,
      id: event.id,
      created: event.created,
      data: event.data,
    });

    // Handle different event types
    switch (event.type) {
      case "payment.succeeded": {
        const payment = event.data.object;
        console.log("🌊 XFlow payment succeeded:", {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          customer: payment.customer,
        });

        await handleXFlowPaymentSuccess(
          payment.id,
          payment.customer?.email,
          payment.metadata || {},
        );
        break;
      }

      case "payment.failed": {
        const failedPayment = event.data.object;
        console.log("🌊 XFlow payment failed:", {
          id: failedPayment.id,
          failure_code: failedPayment.failure_code,
          failure_message: failedPayment.failure_message,
        });

        await handleXFlowPaymentFailure(failedPayment.id);
        break;
      }

      case "payment.pending": {
        const pendingPayment = event.data.object;
        console.log("🌊 XFlow payment pending:", {
          id: pendingPayment.id,
          status: pendingPayment.status,
        });
        // Log but don't process pending payments
        break;
      }

      case "subscription.created": {
        const subscription = event.data.object;
        console.log("🌊 XFlow subscription created:", {
          id: subscription.id,
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
        });

        if (subscription.status === "active") {
          await handleXFlowPaymentSuccess(
            subscription.latest_invoice,
            subscription.customer?.email,
            subscription.metadata || {},
          );
        }
        break;
      }

      case "subscription.updated": {
        const updatedSub = event.data.object;
        console.log("🌊 XFlow subscription updated:", {
          id: updatedSub.id,
          status: updatedSub.status,
        });

        if (updatedSub.status === "active") {
          await handleXFlowPaymentSuccess(
            updatedSub.latest_invoice,
            updatedSub.customer?.email,
            updatedSub.metadata || {},
          );
        } else if (
          updatedSub.status === "canceled" ||
          updatedSub.status === "incomplete_expired"
        ) {
          await handleXFlowPaymentFailure(updatedSub.latest_invoice);
        }
        break;
      }

      case "subscription.deleted": {
        const deletedSub = event.data.object;
        console.log("🌊 XFlow subscription deleted:", {
          id: deletedSub.id,
          status: deletedSub.status,
        });
        // Handle subscription deletion if needed
        break;
      }

      default:
        console.log(`🌊 Unhandled XFlow event type: ${event.type}`);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("XFlow webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

// Helper function to handle successful XFlow payments
async function handleXFlowPaymentSuccess(
  paymentId: string,
  userEmail?: string,
  metadata: Record<string, string> = {},
) {
  await prisma.$transaction(async (tx) => {
    // Find payment record by payment ID (stored as paymentIntent)
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentId },
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
      console.error("Payment record not found for XFlow payment:", paymentId);
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
      console.log("Creating appointment for XFlow payment:", payment.id);
      await createAppointmentFromPayment(tx, payment, metadata);
    } else {
      // Confirm existing appointment
      await confirmExistingAppointment(tx, payment.appointmentId);
    }

    console.log("✅ XFlow payment processed successfully");
  });
}

// Helper function to handle failed XFlow payments
async function handleXFlowPaymentFailure(paymentId: string) {
  await prisma.$transaction(async (tx) => {
    // Find and update payment record
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentId },
      include: { appointment: true },
    });

    if (!payment) {
      console.warn(`Payment not found for XFlow ID: ${paymentId}`);
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

    console.log(`Processed XFlow payment failure: ${payment.id}`);
  });
}

// Helper function to create appointment from payment record
async function createAppointmentFromPayment(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    userId: string;
    user: { consulteeProfile: { id: string } | null };
  },
  metadata: Record<string, string>,
) {
  // For XFlow, we can use metadata like Stripe to store appointment details
  const { type, planId, slotIds, title } = metadata;

  console.log("Creating appointment from XFlow metadata:", {
    type,
    planId,
    slotIds,
  });

  if (!type || !slotIds) {
    console.warn(
      "XFlow appointment creation needs implementation - metadata not available",
    );
    return;
  }

  const slotIdArray =
    typeof slotIds === "string" ? slotIds.split(",") : slotIds;

  // Determine the appointment type enum value
  const appointmentTypeMap: Record<string, "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS"> = {
    consultation: "CONSULTATION",
    subscription: "SUBSCRIPTION",
    webinar: "WEBINAR",
    class: "CLASS",
  };
  const appointmentType = appointmentTypeMap[type];
  if (!appointmentType) {
    throw new Error(`Unknown appointment type: ${type}`);
  }

  // consulteeProfileId is needed for consultation/subscription requestedById
  // The caller validates payment.user.consulteeProfile is not null before calling
  const consulteeProfileId = payment.user.consulteeProfile!.id;

  // Create type-specific record first, then create the appointment linking to it
  let appointment;

  switch (type) {
    case "consultation": {
      if (!planId) throw new Error("Missing planId for consultation");
      const consultation = await tx.consultation.create({
        data: {
          consultationPlanId: planId,
          requestedById: consulteeProfileId,
          requestStatus: RequestStatus.PENDING,
        },
      });
      appointment = await tx.appointment.create({
        data: {
          appointmentType,
          consultation: { connect: { id: consultation.id } },
        },
      });
      break;
    }

    case "subscription": {
      if (!planId) throw new Error("Missing planId for subscription");
      const subscription = await tx.subscription.create({
        data: {
          subscriptionPlanId: planId,
          requestedById: consulteeProfileId,
          requestStatus: RequestStatus.PENDING,
          schedulingPeriodStartsAt: new Date(),
          schedulingPeriodEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      appointment = await tx.appointment.create({
        data: {
          appointmentType,
          subscription: { connect: { id: subscription.id } },
        },
      });
      break;
    }

    case "webinar": {
      if (!planId) throw new Error("Missing planId for webinar");
      const webinar = await tx.webinar.create({
        data: {
          webinarPlanId: planId,
          status: "SCHEDULED",
        },
      });
      appointment = await tx.appointment.create({
        data: {
          appointmentType,
          webinar: { connect: { id: webinar.id } },
        },
      });
      break;
    }

    case "class": {
      if (!planId) throw new Error("Missing planId for class");
      const classRecord = await tx.class.create({
        data: {
          classPlanId: planId,
          status: "SCHEDULED",
        },
      });
      appointment = await tx.appointment.create({
        data: {
          appointmentType,
          class: { connect: { id: classRecord.id } },
        },
      });
      break;
    }

    default:
      throw new Error(`Unknown appointment type: ${type}`);
  }

  // Link existing tentative slots to this appointment by updating them
  for (const slotId of slotIdArray) {
    const trimmedId = slotId.trim();
    await tx.slotOfAppointment.update({
      where: { id: trimmedId },
      data: {
        appointmentId: appointment.id,
        isTentative: false,
      },
    });
  }

  console.log(
    `[XFlow] Created ${type} appointment from metadata:`,
    title || "(no title)",
  );

  // Link payment to the new appointment
  await tx.payment.update({
    where: { id: payment.id },
    data: { appointmentId: appointment.id },
  });

  console.log(`✅ Created ${type} appointment: ${appointment.id}`);
}

// Helper function to confirm existing appointment
async function confirmExistingAppointment(tx: Prisma.TransactionClient, appointmentId: string) {
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
      data: { requestStatus: RequestStatus.PENDING },
    });
  }

  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.PENDING },
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
async function cleanupFailedPaymentAppointment(tx: Prisma.TransactionClient, appointmentId: string) {
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
