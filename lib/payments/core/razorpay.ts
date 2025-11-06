import Razorpay from "razorpay";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  PaymentError,
  RefundError,
  CURRENCY_MULTIPLIERS,
} from "./types";
import { RefundStatus } from "@prisma/client";

// ============================================================================
// Razorpay Client Initialization
// ============================================================================

const initializeRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    console.warn(
      "RAZORPAY_KEY_ID or RAZORPAY_SECRET not found in environment variables",
    );
    return null;
  }
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

export const razorpayClient = initializeRazorpayClient();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert amount to smallest currency unit (paise, cents, etc.)
 */
const toSmallestUnit = (amount: number, currency: string): number => {
  const multiplier = CURRENCY_MULTIPLIERS[currency] || 100;
  return Math.round(amount * multiplier);
};

/**
 * Convert from smallest currency unit to base unit
 */
const fromSmallestUnit = (amount: number, currency: string): number => {
  const multiplier = CURRENCY_MULTIPLIERS[currency] || 100;
  return amount / multiplier;
};

// ============================================================================
// Checkout/Order Operations
// ============================================================================

/**
 * Create a Razorpay Order
 */
export async function createRazorpayOrder({
  amount,
  currency,
  metadata,
}: PaymentIntentParams): Promise<PaymentIntent> {
  if (!razorpayClient) {
    throw new PaymentError(
      "Razorpay client not initialized - check RAZORPAY_KEY_ID and RAZORPAY_SECRET environment variables",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    const order = await razorpayClient.orders.create({
      amount: toSmallestUnit(amount, currency),
      currency,
      notes: metadata,
      receipt: `receipt_${Date.now()}`,
    });

    return {
      id: order.id,
      client_secret: order.id, // Razorpay uses order ID as client secret
      amount: fromSmallestUnit(Number(order.amount), order.currency),
      currency: order.currency,
      status: order.status,
    };
  } catch (error) {
    console.error("Razorpay order creation failed:", error);
    throw handleRazorpayError(error);
  }
}

/**
 * Cancel a Razorpay order (best effort - cannot actually cancel after payment)
 */
export async function cancelRazorpayOrder(orderId: string): Promise<void> {
  if (!razorpayClient) {
    console.warn("Razorpay client not initialized - cannot cancel order");
    return;
  }

  try {
    // Check if there are any payments for this order
    const payments = await razorpayClient.orders.fetchPayments(orderId);
    if (payments.count === 0) {
      console.log(`✅ Razorpay order had no payments, safe to ignore: ${orderId}`);
      return;
    }
    console.warn(
      `⚠️ Cannot cancel Razorpay order with existing payments: ${orderId}`,
    );
  } catch {
    // If we can't fetch payments, assume it's safe to ignore
    console.log(`✅ Razorpay order fetch failed (likely safe to ignore): ${orderId}`);
  }
}

// ============================================================================
// Refund Operations
// ============================================================================

/**
 * Create a refund for a Razorpay payment
 * Note: Razorpay refunds are created on payment IDs, not order IDs
 */
export async function createRazorpayRefund({
  paymentIntentId,
  amount,
  reason,
  metadata,
}: RefundParams): Promise<RefundResult> {
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized - cannot process refund",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    // First, get the payment ID from the order
    const payments = await razorpayClient.orders.fetchPayments(
      paymentIntentId,
    );

    if (payments.count === 0) {
      throw new RefundError(
        "No payment found for this order",
        "NO_PAYMENT_FOUND",
        "RAZORPAY",
      );
    }

    const payment = payments.items[0];

    // Create refund on the payment
    const refund = await razorpayClient.payments.refund(payment.id, {
      amount: amount
        ? toSmallestUnit(amount, payment.currency || "INR")
        : undefined,
      notes: {
        reason: reason || "requested_by_customer",
        ...metadata,
      },
    });

    return {
      refundId: refund.id,
      amount: fromSmallestUnit(
        Number(refund.amount),
        refund.currency || "INR",
      ),
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapRazorpayRefundStatus(refund.status),
      metadata: refund.notes ? (refund.notes as Record<string, unknown>) : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund creation failed:", error);
    throw handleRazorpayRefundError(error);
  }
}

/**
 * Get refund status from Razorpay
 */
export async function getRazorpayRefund(
  refundId: string,
): Promise<RefundResult> {
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    const refund = await razorpayClient.refunds.fetch(refundId);

    return {
      refundId: refund.id,
      amount: fromSmallestUnit(
        Number(refund.amount),
        refund.currency || "INR",
      ),
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapRazorpayRefundStatus(refund.status),
      metadata: refund.notes ? (refund.notes as Record<string, unknown>) : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund retrieval failed:", error);
    throw handleRazorpayRefundError(error);
  }
}

/**
 * List all refunds for a payment
 */
export async function listRazorpayRefunds(
  paymentId: string,
  limit: number = 10,
): Promise<RefundResult[]> {
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    // Razorpay doesn't have a direct endpoint to list refunds by payment
    // We need to fetch all refunds and filter manually
    const refundsResponse = await razorpayClient.refunds.all({
      count: 100, // Fetch more to filter
    });

    // Filter refunds by payment ID
    const filteredRefunds = refundsResponse.items
      .filter((refund) => (refund as { payment_id?: string }).payment_id === paymentId)
      .slice(0, limit);

    return filteredRefunds.map((refund) => ({
      refundId: refund.id,
      amount: fromSmallestUnit(
        Number(refund.amount),
        refund.currency || "INR",
      ),
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapRazorpayRefundStatus(refund.status),
      metadata: refund.notes || undefined,
    }));
  } catch (error) {
    console.error("Razorpay refunds list failed:", error);
    throw handleRazorpayRefundError(error);
  }
}

// ============================================================================
// Dispute Operations (Webhook-only)
// ============================================================================

/**
 * Note: Razorpay does not have a direct API for managing disputes.
 * Disputes are handled through the Razorpay dashboard and webhook events.
 *
 * Webhook events to listen for:
 * - payment.dispute.created
 * - payment.dispute.won
 * - payment.dispute.lost
 * - payment.dispute.closed
 *
 * These events will be handled in the webhook route.
 */

// ============================================================================
// Mapping Helpers
// ============================================================================

function mapRazorpayRefundStatus(status: string | null): RefundStatus {
  switch (status) {
    case "processed":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    default:
      return "PENDING";
  }
}

// ============================================================================
// Error Handlers
// ============================================================================

function handleRazorpayError(error: unknown): PaymentError {
  if (error && typeof error === "object" && "error" in error) {
    const razorpayError = error as {
      error: { code?: string; description?: string };
    };

    const code = razorpayError.error.code || "UNKNOWN_ERROR";
    const description =
      razorpayError.error.description || "Failed to create order";

    if (code.includes("BAD_REQUEST_ERROR")) {
      return new PaymentError(
        "Authentication failed - Invalid Razorpay credentials",
        "AUTH_ERROR",
        "RAZORPAY",
        error,
      );
    }

    if (code.includes("GATEWAY_ERROR")) {
      return new PaymentError(
        "Payment gateway temporarily unavailable",
        "GATEWAY_ERROR",
        "RAZORPAY",
        error,
      );
    }

    return new PaymentError(description, code, "RAZORPAY", error);
  }

  return new PaymentError(
    "Failed to create payment order",
    "UNKNOWN_ERROR",
    "RAZORPAY",
    error,
  );
}

function handleRazorpayRefundError(error: unknown): RefundError {
  if (error && typeof error === "object" && "error" in error) {
    const razorpayError = error as {
      error: { code?: string; description?: string };
    };

    const code = razorpayError.error.code || "UNKNOWN_ERROR";
    const description =
      razorpayError.error.description || "Failed to process refund";

    return new RefundError(description, code, "RAZORPAY", error);
  }

  return new RefundError(
    "Failed to process refund",
    "UNKNOWN_ERROR",
    "RAZORPAY",
    error,
  );
}
