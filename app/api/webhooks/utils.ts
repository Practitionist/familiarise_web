import prisma from "../../../lib/prisma";
import { Prisma, PaymentGateway } from "@prisma/client";
import crypto from "crypto";
import { stripeClient } from "@/lib/payments/core/stripe";
import { razorpayClient } from "@/lib/payments/core/razorpay";
import { handlePayoutWebhook, refundEarnings } from "@/lib/payments/payouts";
import {
  notifyRefundProcessed,
  notifyDisputeCreated,
  notifyDisputeResolved,
} from "@/lib/novu";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { getAppUrl } from "@/lib/url";

// Re-export payment handlers from lib (architectural fix)
export {
  handlePaymentSuccess,
  handlePaymentFailure,
} from "@/lib/payments/webhooks/handlers";

/**
 * Lightweight DB health check for webhook handlers.
 *
 * Returns false when the DB is unreachable or mid-migration.
 * Webhook handlers should return 503 when this is false — payment gateways
 * (Stripe, Razorpay, etc.) will retry the webhook automatically after a
 * delay, so no events are lost.
 */
export async function isDbHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

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

    // FIX #4: Extract refund side effects into a helper so they run on BOTH
    // new refund creation AND status transitions (e.g. PENDING → SUCCEEDED).
    // FIX P2-1: Accepts refund amount for partial-refund-aware credit restoration.
    const runRefundSideEffects = async (
      paymentId: string,
      refundStatus: string,
      refundAmt?: number,
      originalPaymentAmt?: number,
    ) => {
      if (mapRefundStatus(refundStatus) !== "SUCCEEDED") return;

      try {
        await refundEarnings(paymentId);
        console.log(`💰 Earnings refunded for payment ${paymentId}`);
      } catch (earningsError) {
        // Log but don't fail - earnings can be manually updated
        // refundEarnings already guards against double-refund (checks REFUNDED status)
        console.error(
          `⚠️ Failed to refund earnings for payment ${paymentId}:`,
          earningsError,
        );
      }

      try {
        const restored = await reverseCreditsForPayment(
          paymentId,
          tx,
          refundAmt,
          originalPaymentAmt,
        );
        if (restored > 0) {
          console.log(
            `🔄 Reversed ${restored} referral credits for refunded payment ${paymentId}`,
          );
        }
      } catch (creditError) {
        console.error(
          `⚠️ Failed to reverse referral credits for payment ${paymentId}:`,
          creditError,
        );
      }
    };

    if (existingRefund) {
      // Update status if changed
      if (existingRefund.status !== status) {
        const newStatus = mapRefundStatus(status);
        const wasSucceeded = existingRefund.status === "SUCCEEDED";

        await tx.refund.update({
          where: { refundId },
          data: {
            status: newStatus,
            updatedAt: new Date(),
          },
        });
        console.log(`✅ Refund ${refundId} status updated to ${status}`);

        // Run side effects when transitioning TO SUCCEEDED (but not if already SUCCEEDED)
        if (!wasSucceeded) {
          await runRefundSideEffects(
            payment.id,
            status,
            amount,
            payment.amount,
          );
        }
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

    // Run side effects for new refunds that are already SUCCEEDED
    await runRefundSideEffects(payment.id, status, amount, payment.amount);

    // --- Novu notification (fire-and-forget) ---
    void notifyRefundProcessed(payment.userId, {
      amount,
      currency,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
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

    // --- Novu notification (fire-and-forget) ---
    void notifyDisputeCreated([payment.userId], {
      disputeId,
      amount,
      currency,
      reason,
      status: mapDisputeStatus(status),
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
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

    // --- Novu notification for resolved disputes (fire-and-forget) ---
    const resolvedStatuses = [
      "WON",
      "LOST",
      "CHARGE_REFUNDED",
      "WARNING_CLOSED",
    ];
    if (resolvedStatuses.includes(mapDisputeStatus(status))) {
      const disputePayment = await tx.payment.findUnique({
        where: { id: dispute.paymentId },
      });

      if (disputePayment) {
        void notifyDisputeResolved([disputePayment.userId], {
          disputeId,
          amount: dispute.amount,
          currency: dispute.currency,
          reason: dispute.reason || undefined,
          status: mapDisputeStatus(status),
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
      }
    }
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

// ============================================================================
// Webhook Event Logging
// ============================================================================

/**
 * Log webhook event for audit trail and debugging
 * Prevents duplicate processing via unique eventId constraint
 */
export async function logWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<{ isNew: boolean; eventRecordId?: string }> {
  try {
    // Check if event already processed (idempotency)
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      console.log(`⚠️ Webhook event ${eventId} already received, skipping`);
      return { isNew: false, eventRecordId: existing.id };
    }

    // Create new event record
    const event = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        signature,
        processed: false,
      },
    });

    return { isNew: true, eventRecordId: event.id };
  } catch (error) {
    // Handle unique constraint violation (race condition)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`⚠️ Webhook event ${eventId} duplicate (race condition)`);
      return { isNew: false };
    }
    throw error;
  }
}

/**
 * Mark webhook event as processed
 */
export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { eventId },
    data: {
      processed: true,
      processedAt: new Date(),
      error,
    },
  });
}

// ============================================================================
// Payout Webhook Handlers
// ============================================================================

/**
 * Handle RazorpayX payout webhook events
 */
export async function handleRazorpayPayoutWebhook(
  eventType: string,
  payoutData: {
    id: string;
    status: string;
    failure_reason?: string;
  },
): Promise<void> {
  // Map RazorpayX status to our internal status
  const statusMap: Record<
    string,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  > = {
    queued: "PENDING",
    pending: "PENDING",
    processing: "PROCESSING",
    processed: "COMPLETED",
    reversed: "FAILED",
    rejected: "FAILED",
    cancelled: "CANCELLED",
  };

  const status = statusMap[payoutData.status] || "PENDING";

  await handlePayoutWebhook(
    PaymentGateway.RAZORPAY,
    payoutData.id,
    status,
    payoutData.failure_reason,
  );

  console.log(
    `✅ RazorpayX payout ${payoutData.id} webhook processed: ${status}`,
  );
}

/**
 * Handle Stripe Connect payout/transfer webhook events
 */
export async function handleStripePayoutWebhook(
  eventType: string,
  payoutData: {
    id: string;
    status: string;
    failure_code?: string;
    failure_message?: string;
  },
): Promise<void> {
  // Map Stripe status to our internal status
  const statusMap: Record<
    string,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  > = {
    pending: "PENDING",
    in_transit: "PROCESSING",
    paid: "COMPLETED",
    failed: "FAILED",
    canceled: "CANCELLED",
  };

  const status = statusMap[payoutData.status] || "PENDING";
  const failureReason = payoutData.failure_message || payoutData.failure_code;

  await handlePayoutWebhook(
    PaymentGateway.STRIPE,
    payoutData.id,
    status,
    failureReason,
  );

  console.log(`✅ Stripe payout ${payoutData.id} webhook processed: ${status}`);
}

/**
 * Handle refund event - update earnings status
 */
export async function handleRefundForEarnings(
  paymentIntentId: string,
): Promise<void> {
  // Find the payment by intent
  const payment = await prisma.payment.findUnique({
    where: { paymentIntent: paymentIntentId },
  });

  if (!payment) {
    console.warn(
      `Payment not found for refund earnings update: ${paymentIntentId}`,
    );
    return;
  }

  // Refund the earnings (will mark as REFUNDED and update consultant balance)
  const success = await refundEarnings(payment.id);

  if (success) {
    console.log(`✅ Earnings refunded for payment ${payment.id}`);
  } else {
    console.warn(`⚠️ Could not refund earnings for payment ${payment.id}`);
  }
}
