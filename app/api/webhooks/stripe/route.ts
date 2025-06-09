import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import prisma from "@/lib/prisma";
import { stripeClient } from "@/lib/payment";
import { PaymentStatus, RequestStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature")!;

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 },
      );
    }

    let event: Stripe.Event;

    try {
      event = stripeClient.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // Log all webhook events
    console.log(`🔔 Stripe Webhook Event: ${event.type}`, {
      id: event.id,
      created: new Date(event.created * 1000).toISOString(),
      data: event.data.object,
    });

    // Handle different event types
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log("✅ Payment succeeded:", {
          id: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          metadata: paymentIntent.metadata,
        });

        // Find and update payment record
        try {
          const payment = await prisma.payment.findUnique({
            where: { paymentIntent: paymentIntent.id },
            include: {
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

          if (!payment || !payment.appointment) {
            console.error(
              "Payment record or appointment not found for intent:",
              paymentIntent.id,
            );
            break;
          }

          // Update payment status
          await prisma.payment.update({
            where: { id: payment.id },
            data: { paymentStatus: PaymentStatus.SUCCEEDED },
          });

          // Confirm the appointment
          await confirmAppointmentFromWebhook(
            paymentIntent.id,
            paymentIntent.metadata,
          );

          console.log("✅ Payment confirmed and appointment created/confirmed");
        } catch (error) {
          console.error("Failed to process successful payment:", error);
        }
        break;

      case "payment_intent.payment_failed":
        const failedPayment = event.data.object as Stripe.PaymentIntent;
        console.log("❌ Payment failed:", {
          id: failedPayment.id,
          last_payment_error: failedPayment.last_payment_error,
          metadata: failedPayment.metadata,
        });

        // Update payment status and handle failed payment
        try {
          const payment = await prisma.payment.findUnique({
            where: { paymentIntent: failedPayment.id },
            include: {
              appointment: true,
            },
          });

          if (payment && payment.appointment) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { paymentStatus: PaymentStatus.FAILED },
            });

            // Optionally cleanup tentative appointment
            await cleanupFailedPaymentAppointment(payment.appointment.id);

            console.log(
              "🧹 Cleaned up failed payment appointment:",
              payment.appointment.id,
            );
          }
        } catch (error) {
          console.error("Failed to process failed payment:", error);
        }
        break;

      case "invoice.payment_succeeded":
        const invoice = event.data.object as Stripe.Invoice;
        console.log("✅ Invoice payment succeeded:", {
          id: invoice.id,
          subscription_id: (invoice as any).subscription,
          amount_paid: invoice.amount_paid,
          customer: invoice.customer,
        });
        break;

      case "customer.subscription.created":
        const subscription = event.data.object as Stripe.Subscription;
        console.log("🆕 Subscription created:", {
          id: subscription.id,
          customer: subscription.customer,
          status: subscription.status,
          billing_cycle_anchor: new Date(
            subscription.billing_cycle_anchor * 1000,
          ).toISOString(),
          start_date: new Date(subscription.start_date * 1000).toISOString(),
        });
        break;

      default:
        console.log(`📄 Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

// Helper function to confirm appointment after successful payment
async function confirmAppointmentFromWebhook(
  paymentIntentId: string,
  metadata: Record<string, string>,
) {
  await prisma.$transaction(async (tx) => {
    // Find the payment record
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });

    if (!payment || !payment.user.consulteeProfile) {
      throw new Error("Payment or user profile not found");
    }

    // If appointment already exists, just confirm it
    if (payment.appointmentId) {
      await confirmExistingAppointment(tx, payment.appointmentId);
      return;
    }

    // Create appointment from metadata
    const appointmentData = {
      appointmentType: metadata.appointmentType as any,
      planId: metadata.planId,
      eventId: metadata.eventId,
      slotStartTimeInUTC: metadata.slotStartTimeInUTC,
      slotEndTimeInUTC: metadata.slotEndTimeInUTC,
      slotOfAvailabilityWeeklyId: metadata.slotOfAvailabilityWeeklyId,
      slotOfAvailabilityCustomId: metadata.slotOfAvailabilityCustomId,
      discountCode: metadata.discountCode,
      notes: metadata.notes,
    };

    let appointment;
    const consulteeProfileId = payment.user.consulteeProfile.id;
    const userId = payment.user.id;

    // Create appointment based on type
    switch (appointmentData.appointmentType) {
      case "CONSULTATION":
        appointment = await createConsultationFromWebhook(
          tx,
          appointmentData,
          consulteeProfileId,
        );
        break;
      case "SUBSCRIPTION":
        appointment = await createSubscriptionFromWebhook(
          tx,
          appointmentData,
          consulteeProfileId,
        );
        break;
      case "WEBINAR":
        appointment = await createWebinarFromWebhook(
          tx,
          appointmentData,
          userId,
        );
        break;
      case "CLASS":
        appointment = await createClassFromWebhook(tx, appointmentData, userId);
        break;
      default:
        throw new Error(
          `Unsupported appointment type: ${appointmentData.appointmentType}`,
        );
    }

    // Link payment to appointment
    await tx.payment.update({
      where: { id: payment.id },
      data: { appointmentId: appointment.id },
    });

    // Set appointment status to PENDING for consultant approval
    await confirmExistingAppointment(tx, appointment.id);

    console.log(
      `✅ Appointment created and confirmed from webhook: ${appointment.id}`,
    );
  });
}

// Helper functions to create appointments from webhook
async function createConsultationFromWebhook(
  tx: any,
  data: any,
  consulteeProfileId: string,
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // Create consultation with PENDING status (waiting for consultant approval)
  const consultation = await tx.consultation.create({
    data: {
      consultationPlan: { connect: { id: plan.id } },
      requestStatus: "PENDING", // Consultant needs to approve
      requestedBy: { connect: { id: consulteeProfileId } },
      requestNotes: data.notes,
      directlyBooked: true,
    },
  });

  // Create appointment with confirmed slots (payment already received)
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: "CONSULTATION",
      consultation: { connect: { id: consultation.id } },
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
          isTentative: false, // Payment confirmed, so slot is confirmed
        },
      },
    },
  });

  return appointment;
}

async function createSubscriptionFromWebhook(
  tx: any,
  data: any,
  consulteeProfileId: string,
) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

  // Create subscription with PENDING status (waiting for consultant approval)
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlan: { connect: { id: plan.id } },
      requestStatus: "PENDING", // Consultant needs to approve
      requestedBy: { connect: { id: consulteeProfileId } },
      requestNotes: data.notes,
      startDate,
      endDate,
    },
  });

  // Create appointment with confirmed slots
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: "SUBSCRIPTION",
      subscription: { connect: { id: subscription.id } },
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
          isTentative: false, // Payment confirmed
        },
      },
    },
  });

  return appointment;
}

async function createWebinarFromWebhook(tx: any, data: any, userId: string) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: true,
      appointment: { include: { slotsOfAppointment: true } },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  // Create or get existing appointment
  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: "WEBINAR",
        webinar: { connect: { id: webinar.id } },
      },
    });
  }

  // Add user to webinar with confirmed slot
  await tx.slotOfAppointment.create({
    data: {
      appointment: { connect: { id: appointment.id } },
      slotStartTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC ||
        new Date(),
      slotEndTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC ||
        new Date(),
      isTentative: false, // Payment confirmed
      user: { connect: { id: userId } },
    },
  });

  return appointment;
}

async function createClassFromWebhook(tx: any, data: any, userId: string) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: { classPlan: true },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  // Create appointment for class with confirmed slot
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: "CLASS",
      class: { connect: { id: classInstance.id } },
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: classInstance.startDate || new Date(),
          slotEndTimeInUTC: classInstance.endDate || new Date(),
          isTentative: false, // Payment confirmed
          user: { connect: { id: userId } },
        },
      },
    },
  });

  return appointment;
}

// Helper function to confirm existing appointment
async function confirmExistingAppointment(tx: any, appointmentId: string) {
  // Make sure slots are non-tentative (should already be for webhook-created appointments)
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  // Note: We keep consultation/subscription status as PENDING for consultant approval
  // Only webinars and classes might need status updates
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  // Keep consultation and subscription as PENDING for consultant approval
  // Webinars and classes are auto-confirmed since they're group events
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

// Helper function to cleanup appointment after failed payment
async function cleanupFailedPaymentAppointment(appointmentId: string) {
  await prisma.$transaction(async (tx) => {
    // For tentative appointments, we can remove them entirely
    // For webinar/class, we only remove the user's slot
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        slotsOfAppointment: true,
        consultation: true,
        subscription: true,
        webinar: true,
        class: true,
      },
    });

    if (!appointment) return;

    // Only cleanup tentative appointments
    const tentativeSlots = appointment.slotsOfAppointment.filter(
      (slot) => slot.isTentative,
    );

    if (tentativeSlots.length > 0) {
      await tx.slotOfAppointment.deleteMany({
        where: {
          appointmentId,
          isTentative: true,
        },
      });

      // If this was a consultation/subscription and all slots are removed,
      // cleanup the related records
      if (appointment.consultation || appointment.subscription) {
        const remainingSlots = await tx.slotOfAppointment.count({
          where: { appointmentId },
        });

        if (remainingSlots === 0) {
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
          await tx.appointment.delete({
            where: { id: appointmentId },
          });
        }
      }
    }
  });
}
