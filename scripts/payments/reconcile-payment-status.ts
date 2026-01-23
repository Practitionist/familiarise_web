/**
 * Payment Status Reconciliation - Core Logic
 *
 * Reconciles payment status with payment gateways (Stripe/Razorpay).
 * Finds PENDING payments and queries gateways for actual status.
 *
 * This catches cases where:
 * - Payment webhook was missed or delayed
 * - DB update failed after gateway processed payment
 * - Network timeout during payment confirmation
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-payment-status.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-payment-status/route.ts (API endpoint)
 *
 * Schedule: Every 30 minutes
 */

import prisma from "../../lib/prisma";
import { PaymentStatus, PaymentGateway } from "@prisma/client";

// Only reconcile payments older than 5 minutes (give webhooks time)
const MIN_AGE_MINUTES = 5;

// Don't reconcile payments older than 7 days
const MAX_AGE_DAYS = 7;

export interface PaymentReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Query Stripe for payment intent status
 */
async function getStripePaymentStatus(
  paymentIntent: string,
): Promise<{ status: string; failureMessage?: string } | null> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return null;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    const pi = await stripe.paymentIntents.retrieve(paymentIntent);
    return {
      status: pi.status,
      failureMessage: pi.last_payment_error?.message,
    };
  } catch (error) {
    console.error(`Failed to get Stripe payment status: ${error}`);
    return null;
  }
}

/**
 * Query Razorpay for order/payment status
 */
async function getRazorpayPaymentStatus(
  orderId: string,
): Promise<{ status: string; paymentId?: string } | null> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.warn("Razorpay credentials not configured");
    return null;
  }

  try {
    // First get the order
    const orderResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${orderId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );

    if (!orderResponse.ok) {
      console.error(`Razorpay order API error: ${orderResponse.status}`);
      return null;
    }

    const order = await orderResponse.json();

    // If order is paid, get the payment details
    if (order.status === "paid") {
      const paymentsResponse = await fetch(
        `https://api.razorpay.com/v1/orders/${orderId}/payments`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          },
        },
      );

      if (paymentsResponse.ok) {
        const payments = await paymentsResponse.json();
        const capturedPayment = payments.items?.find(
          (p: { status: string }) => p.status === "captured",
        );
        if (capturedPayment) {
          return { status: "captured", paymentId: capturedPayment.id };
        }
      }
    }

    return { status: order.status };
  } catch (error) {
    console.error(`Failed to get Razorpay payment status: ${error}`);
    return null;
  }
}

/**
 * Map gateway payment status to our PaymentStatus
 */
function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PaymentStatus | null {
  if (gateway === PaymentGateway.STRIPE) {
    switch (status) {
      case "succeeded":
        return PaymentStatus.SUCCEEDED;
      case "processing":
        return PaymentStatus.PENDING;
      case "requires_payment_method":
        return PaymentStatus.FAILED;
      case "requires_confirmation":
        return PaymentStatus.PENDING;
      case "requires_action":
        return PaymentStatus.PENDING;
      case "canceled":
        return PaymentStatus.FAILED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
    switch (status) {
      case "paid":
      case "captured":
        return PaymentStatus.SUCCEEDED;
      case "created":
      case "attempted":
        return PaymentStatus.PENDING;
      case "failed":
        return PaymentStatus.FAILED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Find and reconcile stale PENDING payments
 */
export async function reconcilePaymentStatus(): Promise<PaymentReconciliationResult> {
  const errors: string[] = [];
  let reconciledCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const minAge = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Find stale PENDING payments
  const stalePendingPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.PENDING,
      createdAt: {
        lt: minAge,
        gte: maxAge,
      },
      // Only payments with gateway reference - not an empty string
      NOT: {
        paymentIntent: "",
      },
    },
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `Found ${stalePendingPayments.length} stale PENDING payments to reconcile`,
  );

  for (const payment of stalePendingPayments) {
    console.log(`\nReconciling payment ${payment.id}`);
    console.log(`   Gateway: ${payment.paymentGateway}`);
    console.log(`   Payment Intent: ${payment.paymentIntent}`);
    console.log(`   User: ${payment.user?.name || "Unknown"}`);
    console.log(`   Created: ${payment.createdAt.toISOString()}`);

    // Skip if no payment intent
    if (!payment.paymentIntent) {
      console.log(`   Skipping - no payment intent`);
      skippedCount++;
      continue;
    }

    // Query gateway for actual status
    let gatewayStatus: {
      status: string;
      failureMessage?: string;
      paymentId?: string;
    } | null = null;

    if (payment.paymentGateway === PaymentGateway.STRIPE) {
      gatewayStatus = await getStripePaymentStatus(payment.paymentIntent);
    } else if (payment.paymentGateway === PaymentGateway.RAZORPAY) {
      // For Razorpay, paymentIntent might be orderId
      gatewayStatus = await getRazorpayPaymentStatus(payment.paymentIntent);
    } else {
      console.log(
        `   Skipping - unsupported gateway: ${payment.paymentGateway}`,
      );
      skippedCount++;
      continue;
    }

    if (!gatewayStatus) {
      console.log(`   Could not get status from gateway - skipping`);
      errors.push(`Payment ${payment.id}: Could not query gateway status`);
      skippedCount++;
      continue;
    }

    console.log(`   Gateway status: ${gatewayStatus.status}`);

    // Map gateway status to our status
    const mappedStatus = mapGatewayStatus(
      payment.paymentGateway,
      gatewayStatus.status,
    );

    if (!mappedStatus) {
      console.log(`   Unknown gateway status - skipping`);
      skippedCount++;
      continue;
    }

    // Update if status changed
    if (mappedStatus !== payment.paymentStatus) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: mappedStatus,
        },
      });

      console.log(
        `   Updated status: ${payment.paymentStatus} → ${mappedStatus}`,
      );
      reconciledCount++;

      if (mappedStatus === PaymentStatus.SUCCEEDED) {
        succeededCount++;
        console.log(
          `   ⚠️ Payment succeeded - may need manual appointment creation!`,
        );
      } else if (mappedStatus === PaymentStatus.FAILED) {
        failedCount++;
      }
    } else {
      console.log(`   Status unchanged (${mappedStatus})`);
    }
  }

  // Summary
  console.log("\n📊 Payment Reconciliation Summary:");
  console.log(`   Total processed: ${stalePendingPayments.length}`);
  console.log(`   Reconciled: ${reconciledCount}`);
  console.log(`   Succeeded (needs review): ${succeededCount}`);
  console.log(`   Failed: ${failedCount}`);
  console.log(`   Skipped: ${skippedCount}`);

  if (succeededCount > 0) {
    console.log(
      `\n⚠️ WARNING: ${succeededCount} payments were found to have succeeded!`,
    );
    console.log("   These may need manual appointment creation.");
  }

  return {
    success: errors.length === 0,
    totalProcessed: stalePendingPayments.length,
    reconciledCount,
    succeededCount,
    failedCount,
    skippedCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
