```typescript
import crypto from "crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { stripeClient } from "@/lib/payment";
import {
  PaymentStatus,
  RequestStatus,
  WebinarStatus,
  ClassStatus,
  AppointmentsType,
  Prisma,
} from "@prisma/client";
import Stripe from "stripe";
import { validateRazorpayWebhook, type RazorpayWebhookEvent } from "@/schemas/webhook";
import { validateWebhookSignature } from 'razorpay/dist/utils/razorpay-utils';

type WebhookVerificationResult = {
  isValid: boolean;
  gateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW" | null;
  event?: any;
  error?: string;
};

// Timeout wrapper for webhook processing
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number = 25000,
  errorMessage: string = "Operation timed out"
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    )
  ]);
}

// Enhanced Razorpay webhook verification using built-in SDK
function verifyRazorpayWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  try {
    // First try Razorpay's built-in verification
    return validateWebhookSignature(body, signature, secret);
  } catch (error) {
    console.warn("[Razorpay] Built-in verification failed, falling back to manual HMAC:", error);

    // Fallback to manual HMAC verification
    try {
      const shasum = crypto.createHmac("sha256", secret);
      shasum.update(body);
      const digest = shasum.digest("hex");
      return digest === signature;
    } catch (hmacError) {
      console.error("[Razorpay] Manual HMAC verification failed:", hmacError);
      return false;
    }
  }
}

export async function verifyAndParseWebhook(
  req: NextRequest,
  body: string,
): Promise<WebhookVerificationResult> {
  try {
    const userAgent = req.headers.get("user-agent");
    const stripeSignature = req.headers.get("stripe-signature");
    const razorpaySignature = req.headers.get("x-razorpay-signature");
    const lemonSqueezySignature = req.headers.get("x-lemonsqueezy-signature");
    const xflowSignature = req.headers.get("x-xflow-signature");

    // Stripe webhook verification
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
        return {
          isValid: false,
          gateway: "STRIPE",
          error: error instanceof Error ? error.message : "Unknown verification error"
        };
      }
    }

    // Razorpay webhook verification with enhanced validation
    if (razorpaySignature) {
      try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
          throw new Error("RAZORPAY_WEBHOOK_SECRET environment variable is not set");
        }

        // Verify signature using enhanced method
        const isSignatureValid = verifyRazorpayWebhookSignature(
          body,
          razorpaySignature,
          webhookSecret
        );

        if (!isSignatureValid) {
          console.error("[Razorpay Webhook] Signature verification failed");
          return {
            isValid: false,
            gateway: "RAZORPAY",
            error: "Invalid webhook signature"
          };
        }

        // Parse and validate webhook payload
        let parsedEvent;
        try {
          parsedEvent = JSON.parse(body);
        } catch (parseError) {
          console.error("[Razorpay Webhook] JSON parsing failed:", parseError);
          return {
            isValid: false,
            gateway: "RAZORPAY",
            error: "Invalid JSON payload"
          };
        }

        // Validate webhook structure using Zod schema
        const validation = validateRazorpayWebhook(parsedEvent);
        if (!validation.isValid) {
          console.error("[Razorpay Webhook] Schema validation failed:", validation.error);
          return {
            isValid: false,
            gateway: "RAZORPAY",
            error: `Schema validation failed: ${validation.error}`
          };
        }

        console.log(`[Razorpay Webhook] Successfully verified event: ${validation.event?.event}`);
        return {
          isValid: true,
          gateway: "RAZORPAY",
          event: validation.event
        };

      } catch (error) {
        console.error("[Razorpay Webhook] Verification process failed:", error);
        return {
          isValid: false,
          gateway: "RAZORPAY",
          error: error instanceof Error ? error.message : "Unknown verification error"
        };
            }
      }

    // Lemon Squeezy webhook verification
    if (lemonSqueezySignature) {
      try {
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
          return {
            isValid: false,
            gateway: "LEMON_SQUEEZY",
            error: "Invalid webhook signature"
          };
        }
      } catch (error) {
        console.error("[Lemon Squeezy Webhook] Verification process failed:", error);
        return {
          isValid: false,
          gateway: "LEMON_SQUEEZY",
          error: error instanceof Error ? error.message : "Unknown verification error"
        };
      }
    }

    // XFLOW webhook verification
    if (xflowSignature) {
      try {
        const secret = process.env.XFLOW_WEBHOOK_SECRET!;
        const hmac = crypto.createHmac("sha256", secret);
        const digest = Buffer.from(hmac.update(body).digest("hex"), "utf8");
        const signature = Buffer.from(xflowSignature, "utf8");

        if (digest.equals(signature)) {
          return { isValid: true, gateway: "XFLOW", event: JSON.parse(body) };
        } else {
          console.error("[Xflow Webhook] Verification failed.");
          return {
            isValid: false,
            gateway: "XFLOW",
            error: "Invalid webhook signature"
          };
        }
      } catch (error) {
        console.error("[XFLOW Webhook] Verification process failed:", error);
        return {
          isValid: false,
          gateway: "XFLOW",
          error: error instanceof Error ? error.message : "Unknown verification error"
        };
      }
    }

    return { isValid: false, gateway: null, error: "No supported webhook signature found" };
  } catch (error) {
    console.error("[Webhook] Global verification error:", error);
    console.error("[Webhook] Headers:", Object.fromEntries(req.headers.entries()));
    console.error("[Webhook] Body length:", body.length);
    return {
      isValid: false,
      gateway: null,
      error: error instanceof Error ? error.message : "Unknown webhook processing error"
    };
  }
}

type StandardizedEvent = {
  eventType: "payment.succeeded" | "payment.failed" | "payment.authorized" | "payment.disputed" | "refund.created" | "settlement.processed";
  paymentIntentId: string;
  metadata: any;
  amount?: number;
  refundId?: string;
  disputeId?: string;
  settlementId?: string;
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
          amount: paymentEntity.amount,
        };
      }
      case "payment.authorized": {
        const authorizedPayment = event.payload.payment.entity;
        return {
          eventType: "payment.authorized",
          paymentIntentId: authorizedPayment.order_id,
          metadata: authorizedPayment.notes ?? {},
          amount: authorizedPayment.amount,
        };
      }
      case "payment.failed": {
        const failedPayment = event.payload.payment.entity;
        return {
          eventType: "payment.failed",
          paymentIntentId: failedPayment.order_id,
          metadata: failedPayment.notes ?? {},
          amount: failedPayment.amount,
        };
      }
      case "payment.dispute.created": {
        const dispute = event.payload.dispute.entity;
        return {
          eventType: "payment.disputed",
          paymentIntentId: dispute.payment_id,
          metadata: {},
          amount: dispute.amount,
          disputeId: dispute.id,
        };
      }
      case "refund.created":
      case "refund.processed": {
        const refund = event.payload.refund.entity;
        return {
          eventType: "refund.created",
          paymentIntentId: refund.payment_id,
          metadata: refund.notes ?? {},
          amount: refund.amount,
          refundId: refund.id,
        };
      }
      case "settlement.processed": {
        const settlement = event.payload.settlement.entity;
        return {
          eventType: "settlement.processed",
          paymentIntentId: settlement.id, // Settlement doesn't have order_id
          metadata: {},
          amount: settlement.amount,
          settlementId: settlement.id,
        };
      }
      default:
        console.warn(`[Razorpay] Unhandled event type: ${event.event}`);
        return null;
    }
  }

  if (gateway === "LEMON_SQUEEZY") {
    if (event.meta.event_name === "order_created") {
      return {
        eventType: "payment.succeeded",
        paymentIntentId: event.data.attributes.first_order_item.order_id.toString(),
        metadata: event.meta.custom_data ?? {},
      };
    }
    if (event.meta.event_name === "order_refunded") {
      return {
        eventType: "payment.failed",
        paymentIntentId: event.data.attributes.first_order_item.order_id.toString(),
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
  try {
    await withTimeout(
      processEventInternal(event),
      25000,
      `Webhook processing timeout for event: ${event.eventType}`
    );
  } catch (error) {
    console.error(`[Webhook] Processing failed for event ${event.eventType}:`, error);
    throw error;
  }
}

async function processEventInternal(event: StandardizedEvent) {
  console.log(`[Webhook] Processing event: ${event.eventType} for payment: ${event.paymentIntentId}`);

  switch (event.eventType) {
    case "payment.succeeded":
      await handleSuccessfulPayment(event.paymentIntentId, event.metadata);
      break;
    case "payment.failed":
      await handleFailedPayment(event.paymentIntentId);
      break;
    case "payment.authorized":
      await handleAuthorizedPayment(event.paymentIntentId, event.metadata, event.amount);
      break;
    case "payment.disputed":
      await handleDisputedPayment(event.paymentIntentId, event.disputeId, event.amount);
      break;
    case "refund.created":
      await handleRefundCreated(event.paymentIntentId, event.refundId, event.amount);
      break;
    case "settlement.processed":
      await handleSettlementProcessed(event.settlementId, event.amount);
      break;
    default:
      console.warn(`[Webhook] Unhandled event type: ${event.eventType}`);
  }
}

async function handleSuccessfulPayment(
  paymentIntentId: string,
  metadata: any,
) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });

    if (!payment) {
      throw new Error(`Payment not found for intent: ${paymentIntentId}`);
    }

    if (payment.paymentStatus === "SUCCEEDED") {
      console.log(
        `Payment ${paymentIntentId} has already been processed.`,
      );
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

// New handler functions for additional Razorpay events

async function handleAuthorizedPayment(
  paymentIntentId: string,
  metadata: any,
  amount?: number,
) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
    });

    if (!payment) {
      console.warn(`Payment not found for authorized intent: ${paymentIntentId}`);
      return;
    }

    if (payment.paymentStatus === "SUCCEEDED") {
      console.log(`Payment ${paymentIntentId} is already captured.`);
      return;
    }

    // Update payment status to authorized (waiting for capture)
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PaymentStatus.PENDING, // Authorized but not captured
      },
    });

    console.log(`Payment ${paymentIntentId} authorized successfully. Amount: ${amount}`);
  });
}

async function handleDisputedPayment(
  paymentIntentId: string,
  disputeId?: string,
  amount?: number,
) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { appointment: true },
    });

    if (!payment) {
      console.warn(`Payment not found for disputed intent: ${paymentIntentId}`);
      return;
    }

    // Update payment status to disputed
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PaymentStatus.FAILED,
      },
    });

    // Optionally handle appointment cancellation for disputes
    if (payment.appointmentId) {
      await cleanupFailedPaymentAppointment(tx, payment.appointmentId);
    }

    console.log(`Payment ${paymentIntentId} marked as disputed. Dispute ID: ${disputeId}, Amount: ${amount}`);
  });
}

async function handleRefundCreated(
  paymentIntentId: string,
  refundId?: string,
  amount?: number,
) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
    });

    if (!payment) {
      console.warn(`Payment not found for refund intent: ${paymentIntentId}`);
      return;
    }

    // Log refund information (no payment status change needed for successful refunds)
    // Note: If you need to track refund information, consider adding a refunds table

    console.log(`Refund created for payment ${paymentIntentId}. Refund ID: ${refundId}, Amount: ${amount}`);
  });
}

async function handleSettlementProcessed(
  settlementId?: string,
  amount?: number,
) {
  // Settlement processing is usually for informational purposes
  // You might want to update financial records or send notifications
  console.log(`Settlement processed. Settlement ID: ${settlementId}, Amount: ${amount}`);

  // Optional: Store settlement information in database
  // This would require a settlements table in your schema
}
```
