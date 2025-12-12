import prisma from "../../../lib/prisma";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { stripeClient } from "@/lib/payments/core/stripe";
import { razorpayClient } from "@/lib/payments/core/razorpay";

// Re-export payment handlers from lib (architectural fix)
export {
  handlePaymentSuccess,
  handlePaymentFailure,
} from "@/lib/payments/webhooks/handlers";

// Generic webhook verification
export async function verifyWebhookSignature(
  req: Request,
  secret: string,
  gateway: "stripe" | "razorpay",
): Promise<{ isValid: boolean; body: string }> {
  const signature =
    req.headers.get("stripe-signature") ||
    req.headers.get("x-razorpay-signature");

  if (!signature) {
    return { isValid: false, body: "" };
  }

  const body = await req.text();

  try {
    if (gateway === "stripe") {
      if (!stripeClient) {
        console.error(
          "Stripe client not initialized - cannot verify webhook signature",
        );
        return { isValid: false, body: "" };
      }
      stripeClient.webhooks.constructEvent(body, signature, secret);
      return { isValid: true, body };
    } else {
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");
      return { isValid: signature === expectedSignature, body };
    }
  } catch (error) {
    console.error(
      `Webhook signature verification failed for ${gateway}:`,
      error,
    );
    return { isValid: false, body };
  }
}

// ============================================================================
// Refund Webhook Handlers
// ============================================================================

/**
 * Handle refund created/processed event
 */
export async function handleRefundCreated(
  refundId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
  status: string,
  gateway: "STRIPE" | "RAZORPAY",
) {
  return await prisma.$transaction(async (tx) => {
    // Find the payment
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
    });

    if (!payment) {
      console.warn(`Payment not found for refund: ${refundId}`);
      return;
    }

    // Check if refund already exists
    const existingRefund = await tx.refund.findUnique({
      where: { refundId },
    });

    if (existingRefund) {
      // Update status if changed
      if (existingRefund.status !== status) {
        await tx.refund.update({
          where: { refundId },
          data: {
            status: mapRefundStatus(status),
            updatedAt: new Date(),
          },
        });
        console.log(`✅ Refund ${refundId} status updated to ${status}`);
      }
      return;
    }

    // Create new refund record
    await tx.refund.create({
      data: {
        amount,
        currency,
        status: mapRefundStatus(status),
        refundId,
        paymentGateway: gateway,
        paymentId: payment.id,
      },
    });

    console.log(`✅ Refund ${refundId} created for payment ${payment.id}`);
  });
}

function mapRefundStatus(
  status: string,
): "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" {
  switch (status.toLowerCase()) {
    case "succeeded":
    case "processed":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    default:
      return "PENDING";
  }
}

// ============================================================================
// Dispute Webhook Handlers
// ============================================================================

/**
 * Handle dispute created event
 */
export async function handleDisputeCreated(
  disputeId: string,
  chargeId: string,
  amount: number,
  currency: string,
  reason: string,
  status: string,
  dueBy: number | null,
  isChargeRefundable: boolean,
  gateway: "STRIPE" | "RAZORPAY",
) {
  return await prisma.$transaction(async (tx) => {
    // Find payment by charge ID or payment intent
    // For Stripe, we need to get the payment intent from the charge
    let payment;
    if (gateway === "STRIPE" && stripeClient) {
      try {
        const charge = await stripeClient.charges.retrieve(chargeId);
        if (charge.payment_intent) {
          payment = await tx.payment.findUnique({
            where: {
              paymentIntent:
                typeof charge.payment_intent === "string"
                  ? charge.payment_intent
                  : charge.payment_intent.id,
            },
          });
        }
      } catch (error) {
        console.error("Failed to retrieve charge:", error);
      }
    } else {
      // For Razorpay, chargeId is the payment_id. We need to fetch the payment
      // from Razorpay to get the order_id, which is stored as our paymentIntent.
      if (razorpayClient) {
        try {
          const rzpPayment = await razorpayClient.payments.fetch(chargeId);
          if (rzpPayment.order_id) {
            payment = await tx.payment.findUnique({
              where: { paymentIntent: rzpPayment.order_id },
            });
          }
        } catch (error) {
          console.error(
            `Failed to fetch Razorpay payment ${chargeId} to link dispute:`,
            error,
          );
        }
      }
    }

    if (!payment) {
      console.warn(`Payment not found for dispute: ${disputeId}`);
      return;
    }

    // Check if dispute already exists
    const existingDispute = await tx.dispute.findUnique({
      where: { disputeId },
    });

    if (existingDispute) {
      console.log(`Dispute ${disputeId} already exists`);
      return;
    }

    // Create dispute record
    await tx.dispute.create({
      data: {
        amount,
        currency,
        reason,
        status: mapDisputeStatus(status),
        disputeId,
        paymentGateway: gateway,
        dueBy: dueBy ? new Date(dueBy * 1000) : null,
        isChargeRefundable,
        paymentId: payment.id,
      },
    });

    console.log(`✅ Dispute ${disputeId} created for payment ${payment.id}`);
  });
}

/**
 * Handle dispute updated event (status change, evidence submitted, etc.)
 */
export async function handleDisputeUpdated(
  disputeId: string,
  status: string,
  evidence: Record<string, unknown> | null,
) {
  return await prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({
      where: { disputeId },
    });

    if (!dispute) {
      console.warn(`Dispute not found: ${disputeId}`);
      return;
    }

    await tx.dispute.update({
      where: { disputeId },
      data: {
        status: mapDisputeStatus(status),
        ...(evidence && { evidence: evidence as Prisma.InputJsonValue }),
        updatedAt: new Date(),
      },
    });

    console.log(`✅ Dispute ${disputeId} updated to status ${status}`);
  });
}

function mapDisputeStatus(
  status: string,
):
  | "WARNING_NEEDS_RESPONSE"
  | "WARNING_UNDER_REVIEW"
  | "WARNING_CLOSED"
  | "NEEDS_RESPONSE"
  | "UNDER_REVIEW"
  | "CHARGE_REFUNDED"
  | "WON"
  | "LOST" {
  switch (status.toLowerCase()) {
    case "warning_needs_response":
      return "WARNING_NEEDS_RESPONSE";
    case "warning_under_review":
      return "WARNING_UNDER_REVIEW";
    case "warning_closed":
      return "WARNING_CLOSED";
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "charge_refunded":
      return "CHARGE_REFUNDED";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    default:
      return "NEEDS_RESPONSE";
  }
}
