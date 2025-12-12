```typescript
// api/webhooks/stripe.ts

import { NextRequest, NextResponse } from "next/server";
import {
  verifyAndParseWebhook,
  standardizeWebhookEvent,
  processWebhookEvent,
} from "@/utils/webhooks";

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const { isValid, gateway, event } = await verifyAndParseWebhook(req, body);

    if (!isValid || gateway !== "STRIPE" || !event) {
      return NextResponse.json(
        { error: "Stripe webhook verification failed" },
        { status: 400 },
      );
    }

    console.log(`[Stripe Webhook] Received and verified event: ${event.type}`);

    const standardizedEvent = standardizeWebhookEvent(event, "STRIPE");

    if (standardizedEvent) {
      await processWebhookEvent(standardizedEvent);
    } else {
      console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Webhook handler failed";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

// utils/webhook.ts
import crypto from "crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { stripeClient, verifyRazorpayWebhook } from "@/lib/payment";
import {
  PaymentStatus,
  RequestStatus,
  WebinarStatus,
  ClassStatus,
  AppointmentsType,
  Prisma,
} from "@prisma/client";
import Stripe from "stripe";

type WebhookVerificationResult = {
  isValid: boolean;
  gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW" | null;
  event?: any;
};

export async function verifyAndParseWebhook(
  req: NextRequest,
  body: string,
): Promise<WebhookVerificationResult> {
  const userAgent = req.headers.get("user-agent");
  const stripeSignature = req.headers.get("stripe-signature");
  const razorpaySignature = req.headers.get("x-razorpay-signature");
  const lemonSqueezySignature = req.headers.get("x-lemonsqueezy-signature");
  const xflowSignature = req.headers.get("x-xflow-signature");

  if (userAgent?.includes("Stripe") && stripeSignature) {
    try {
      const event = stripeClient.webhooks.constructEvent(
        body,
        stripeSignature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
      return { isValid: true, gateway: "STRIPE", event };
    } catch (error) {
      console.error("[Stripe Webhook] Verification failed:", error);
      return { isValid: false, gateway: "STRIPE" };
    }
  }

  if (razorpaySignature) {
    const isValid = verifyRazorpayWebhook(
      body,
      razorpaySignature,
      process.env.RAZORPAY_WEBHOOK_SECRET!,
    );
    if (isValid) {
      return { isValid: true, gateway: "RAZORPAY", event: JSON.parse(body) };
    } else {
      console.error("[Razorpay Webhook] Verification failed.");
      return { isValid: false, gateway: "RAZORPAY" };
    }
  }

  if (lemonSqueezySignature) {
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET!;
    const hmac = crypto.createHmac("sha256", secret);
    const digest = Buffer.from(hmac.update(body).digest("hex"), "utf8");
    const signature = Buffer.from(lemonSqueezySignature, "utf8");

    if (digest.equals(signature)) {
      return {
        isValid: true,
        gateway: "LEMON_SQUEEZY",
        event: JSON.parse(body),
      };
    } else {
      console.error("[Lemon Squeezy Webhook] Verification failed.");
      return { isValid: false, gateway: "LEMON_SQUEEZY" };
    }
  }

  if (xflowSignature) {
    // Assuming Xflow uses a similar HMAC SHA256 verification
    const secret = process.env.XFLOW_WEBHOOK_SECRET!;
    const hmac = crypto.createHmac("sha256", secret);
    const digest = Buffer.from(hmac.update(body).digest("hex"), "utf8");
    const signature = Buffer.from(xflowSignature, "utf8");

    if (digest.equals(signature)) {
      return { isValid: true, gateway: "XFLOW", event: JSON.parse(body) };
    } else {
      console.error("[Xflow Webhook] Verification failed.");
      return { isValid: false, gateway: "XFLOW" };
    }
  }

  return { isValid: false, gateway: null };
}

type StandardizedEvent = {
  eventType: "payment.succeeded" | "payment.failed";
  paymentIntentId: string;
  metadata: any;
};

export function standardizeWebhookEvent(
  event: any,
  gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW",
): StandardizedEvent | null {
  if (gateway === "STRIPE") {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        return {
          eventType: "payment.succeeded",
          paymentIntentId: paymentIntent.id,
          metadata: paymentIntent.metadata,
        };
      }
      case "payment_intent.payment_failed": {
        const failedPaymentIntent = event.data.object as Stripe.PaymentIntent;
        return {
          eventType: "payment.failed",
          paymentIntentId: failedPaymentIntent.id,
          metadata: failedPaymentIntent.metadata,
        };
      }
      default:
        return null;
    }
  }

  if (gateway === "RAZORPAY") {
    switch (event.event) {
      case "payment.captured":
      case "order.paid": {
        const paymentEntity =
          event.payload.payment?.entity ?? event.payload.order?.entity;
        return {
          eventType: "payment.succeeded",
          paymentIntentId: paymentEntity.order_id ?? paymentEntity.id,
          metadata: paymentEntity.notes ?? {},
        };
      }
      case "payment.failed": {
        const failedPayment = event.payload.payment.entity;
        return {
          eventType: "payment.failed",
          paymentIntentId: failedPayment.order_id,
          metadata: failedPayment.notes ?? {},
        };
      }
      default:
        return null;
    }
  }

  if (gateway === "LEMON_SQUEEZY") {
    if (event.meta.event_name === "order_created") {
      return {
        eventType: "payment.succeeded",
        paymentIntentId:
          event.data.attributes.first_order_item.order_id.toString(),
        metadata: event.meta.custom_data ?? {},
      };
    }
    if (event.meta.event_name === "order_refunded") {
      return {
        eventType: "payment.failed",
        paymentIntentId:
          event.data.attributes.first_order_item.order_id.toString(),
        metadata: event.meta.custom_data ?? {},
      };
    }
  }

  if (gateway === "XFLOW") {
    if (event.type === "payment.succeeded") {
      return {
        eventType: "payment.succeeded",
        paymentIntentId: event.data.id,
        metadata: event.data.metadata ?? {},
      };
    }
    if (event.type === "payment.failed") {
      return {
        eventType: "payment.failed",
        paymentIntentId: event.data.id,
        metadata: event.data.metadata ?? {},
      };
    }
  }

  return null;
}

export async function processWebhookEvent(event: StandardizedEvent) {
  switch (event.eventType) {
    case "payment.succeeded":
      await handleSuccessfulPayment(event.paymentIntentId, event.metadata);
      break;
    case "payment.failed":
      await handleFailedPayment(event.paymentIntentId);
      break;
  }
}

async function handleSuccessfulPayment(paymentIntentId: string, metadata: any) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });

    if (!payment) {
      throw new Error(`Payment not found for intent: ${paymentIntentId}`);
    }

    if (payment.paymentStatus === "SUCCEEDED") {
      console.log(`Payment ${paymentIntentId} has already been processed.`);
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    let appointmentId = payment.appointmentId;
    if (!appointmentId) {
      const appointmentData = {
        appointmentType: metadata.appointmentType as AppointmentsType,
        planId: metadata.planId,
        eventId: metadata.eventId,
        slotStartTimeInUTC: metadata.slotStartTimeInUTC,
        slotEndTimeInUTC: metadata.slotEndTimeInUTC,
        notes: metadata.notes,
        userId: payment.userId,
        consulteeProfileId: payment.user.consulteeProfile?.id,
      };

      if (!appointmentData.consulteeProfileId) {
        throw new Error(
          `Consultee profile not found for user: ${payment.userId}`,
        );
      }

      const appointment = await createAppointmentFromWebhook(tx, {
        ...appointmentData,
        consulteeProfileId: appointmentData.consulteeProfileId,
      });
      appointmentId = appointment.id;

      await tx.payment.update({
        where: { id: payment.id },
        data: { appointmentId },
      });
    }

    if (appointmentId) {
      await confirmAppointment(tx, appointmentId);
    }
  });
}

async function handleFailedPayment(paymentIntentId: string) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { appointment: true },
    });

    if (!payment) {
      console.warn(`Payment not found for intent: ${paymentIntentId}`);
      return;
    }

    if (payment.paymentStatus === "FAILED") {
      console.log(
        `Payment ${paymentIntentId} has already been marked as failed.`,
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    if (payment.appointmentId) {
      await cleanupFailedPaymentAppointment(tx, payment.appointmentId);
    }
  });
}

async function createAppointmentFromWebhook(
  tx: Prisma.TransactionClient,
  data: {
    appointmentType: AppointmentsType;
    planId: string;
    eventId?: string;
    slotStartTimeInUTC: string;
    slotEndTimeInUTC: string;
    notes?: string;
    userId: string;
    consulteeProfileId: string;
  },
) {
  switch (data.appointmentType) {
    case "CONSULTATION": {
      const consultation = await tx.consultation.create({
        data: {
          consultationPlanId: data.planId,
          requestStatus: RequestStatus.APPROVED,
          requestedById: data.consulteeProfileId,
          requestNotes: data.notes,
          directlyBooked: true,
        },
      });
      return tx.appointment.create({
        data: {
          appointmentType: AppointmentsType.CONSULTATION,
          consultationId: consultation.id,
          slotsOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
              isTentative: false,
            },
          },
        },
      });
    }
    case "SUBSCRIPTION": {
      const subscriptionPlan = await tx.subscriptionPlan.findUnique({
        where: { id: data.planId },
      });
      if (!subscriptionPlan) {
        throw new Error(`Subscription plan not found: ${data.planId}`);
      }
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + subscriptionPlan.durationInMonths);

      const subscription = await tx.subscription.create({
        data: {
          subscriptionPlanId: data.planId,
          requestStatus: RequestStatus.APPROVED,
          requestedById: data.consulteeProfileId,
          requestNotes: data.notes,
          startDate,
          endDate,
        },
      });
      return tx.appointment.create({
        data: {
          appointmentType: AppointmentsType.SUBSCRIPTION,
          subscriptionId: subscription.id,
          slotsOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
              isTentative: false,
            },
          },
        },
      });
    }
    case "WEBINAR": {
      if (!data.eventId) {
        throw new Error("Event ID is required for webinar checkout");
      }
      const webinar = await tx.webinar.findUnique({
        where: { id: data.eventId },
        include: { appointment: { include: { slotsOfAppointment: true } } },
      });
      if (!webinar) {
        throw new Error(`Webinar not found: ${data.eventId}`);
      }
      const webinarAppointment =
        webinar.appointment ??
        (await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.WEBINAR,
            webinarId: webinar.id,
          },
        }));

      await tx.slotOfAppointment.create({
        data: {
          appointmentId: webinarAppointment.id,
          slotStartTimeInUTC:
            webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC ??
            new Date(),
          slotEndTimeInUTC:
            webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC ??
            new Date(),
          isTentative: false,
          user: { connect: { id: data.userId } },
        },
      });
      return tx.appointment.findUniqueOrThrow({
        where: { id: webinarAppointment.id },
      });
    }
    case "CLASS": {
      if (!data.eventId) {
        throw new Error("Event ID is required for class checkout");
      }
      const classInstance = await tx.class.findUnique({
        where: { id: data.eventId },
      });
      if (!classInstance) {
        throw new Error(`Class not found: ${data.eventId}`);
      }
      return tx.appointment.create({
        data: {
          appointmentType: AppointmentsType.CLASS,
          classId: classInstance.id,
          slotsOfAppointment: {
            create: {
              slotStartTimeInUTC: classInstance.startDate ?? new Date(),
              slotEndTimeInUTC: classInstance.endDate ?? new Date(),
              isTentative: false,
              user: { connect: { id: data.userId } },
            },
          },
        },
      });
    }
    default:
      throw new Error(`Unsupported appointment type: ${data.appointmentType}`);
  }
}

async function confirmAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

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
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }
  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }
  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: WebinarStatus.SCHEDULED },
    });
  }
  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: ClassStatus.SCHEDULED },
    });
  }
}

async function cleanupFailedPaymentAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
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

  await tx.slotOfAppointment.deleteMany({
    where: { appointmentId },
  });

  await tx.appointment.delete({
    where: { id: appointmentId },
  });
}
```
