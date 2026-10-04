/**
 * Payments Module - Main Exports
 * Gateway abstraction over Razorpay (plus dev mock payments)
 */

import { PaymentGateway } from "@prisma/client";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  DisputeResult,
  PaymentError,
} from "./core/types";

// Core modules
import {
  createRazorpayOrder,
  cancelRazorpayOrder,
  createRazorpayRefund,
  getRazorpayRefund,
  listRazorpayRefunds,
} from "./core/razorpay";

import { getRazorpayDispute } from "./core/razorpay-disputes";

import { assertGatewayUsable } from "./validation/gateway-guards";

import {
  createMockPaymentIntent,
  cancelMockPayment,
  createMockRefund,
  isMockPaymentId,
  shouldEnableMockPayments,
  logMockPaymentWarning,
} from "./operations/mock";

// Re-export types
export * from "./core/types";

// ============================================================================
// Unified Payment Intent Operations
// ============================================================================

/**
 * Create a payment intent for any supported gateway
 * Automatically routes to the correct gateway implementation
 */
export async function createPaymentIntent(
  params: PaymentIntentParams,
): Promise<PaymentIntent> {
  const { paymentGateway, isMockPayment } = params;

  // Handle mock payments
  if (isMockPayment && shouldEnableMockPayments()) {
    logMockPaymentWarning(paymentGateway);
    return createMockPaymentIntent(params);
  }

  // #1351 — the second door into a live charge. routeGateway fences the
  // checkout route, but the approval-payment path (a consultant approving a
  // request mints an intent from a stored PaymentGateway value, never through
  // the router) reaches this switch directly. Guard here so both doors share
  // one fence. Mock payments are exempt on purpose: they move no money and the
  // dev Mock Pay button still names a gateway.
  assertGatewayUsable(paymentGateway, "create a payment intent");

  if (paymentGateway !== "RAZORPAY") {
    throw new PaymentError(
      `Unsupported payment gateway: ${paymentGateway}`,
      "UNSUPPORTED_GATEWAY",
    );
  }
  return createRazorpayOrder(params);
}

/**
 * Cancel a payment intent
 */
export async function cancelPaymentIntent(
  paymentIntentId: string,
): Promise<void> {
  // Handle mock payments
  if (isMockPaymentId(paymentIntentId)) {
    return cancelMockPayment(paymentIntentId);
  }

  if (paymentIntentId.startsWith("order_")) {
    // #1861 L2 — the order's payment state is the sweep's concern, not this caller's.
    await cancelRazorpayOrder(paymentIntentId);
    return;
  }

  console.warn(
    `⚠️ Payment cancellation not implemented for: ${paymentIntentId}`,
  );
}

// ============================================================================
// Unified Refund Operations
// ============================================================================

/**
 * Create a refund for any supported gateway
 */
export async function createRefund(
  params: RefundParams,
): Promise<RefundResult> {
  const { paymentIntentId } = params;

  // Handle mock refunds
  if (isMockPaymentId(paymentIntentId)) {
    const mockRefund = await createMockRefund(
      paymentIntentId,
      params.amount,
      params.reason,
    );
    return {
      refundId: mockRefund.refundId,
      amount: mockRefund.amount,
      currency: "INR", // L3 FIX: Platform operates in INR
      status: "SUCCEEDED",
    };
  }

  if (
    paymentIntentId.startsWith("order_") ||
    paymentIntentId.startsWith("pay_")
  ) {
    return createRazorpayRefund(params);
  }

  throw new PaymentError(
    `Cannot determine gateway for payment: ${paymentIntentId}`,
    "UNKNOWN_GATEWAY",
  );
}

/**
 * Get refund status
 */
export async function getRefund(
  refundId: string,
  gateway: PaymentGateway,
): Promise<RefundResult> {
  if (gateway !== "RAZORPAY") {
    throw new PaymentError(
      `Refund retrieval not supported for: ${gateway}`,
      "NOT_SUPPORTED",
      gateway,
    );
  }
  return getRazorpayRefund(refundId);
}

/**
 * List refunds for a payment
 */
export async function listRefunds(
  paymentIntentId: string,
  gateway: PaymentGateway,
  limit: number = 10,
): Promise<RefundResult[]> {
  if (gateway !== "RAZORPAY") {
    throw new PaymentError(
      `Refund listing not supported for: ${gateway}`,
      "NOT_SUPPORTED",
      gateway,
    );
  }
  return listRazorpayRefunds(paymentIntentId, limit);
}

// ============================================================================
// Unified Dispute Operations
// ============================================================================

/**
 * Get dispute details
 * Razorpay is polled via GET /v1/disputes/:id; the raw gateway status flows
 * through for the caller to map, and the gateway payment id rides along for
 * the join. Evidence submit + listing stay dashboard-only.
 */
export async function getDispute(
  disputeId: string,
  gateway: PaymentGateway,
): Promise<DisputeResult> {
  if (gateway !== "RAZORPAY") {
    throw new PaymentError(
      `Dispute retrieval not supported for: ${gateway}`,
      "NOT_SUPPORTED",
      gateway,
    );
  }
  return getRazorpayDispute(disputeId);
}
