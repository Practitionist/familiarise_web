/**
 * Payments Module - Main Exports
 * Unified payment gateway abstraction for Stripe, Razorpay, LemonSqueezy, and XFlow
 */

import { PaymentGateway } from "@prisma/client";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  DisputeParams,
  DisputeResult,
  PaymentError,
} from "./core/types";

// Core modules
import {
  createStripeCheckoutSession,
  cancelStripePayment,
  createStripeRefund,
  getStripeRefund,
  listStripeRefunds,
  getStripeDispute,
  submitStripeDisputeEvidence,
  listStripeDisputes,
} from "./core/stripe";

import {
  createRazorpayOrder,
  cancelRazorpayOrder,
  createRazorpayRefund,
  getRazorpayRefund,
  listRazorpayRefunds,
} from "./core/razorpay";

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
export * from "./core/transactions";

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

  // Route to correct gateway
  switch (paymentGateway) {
    case "STRIPE":
      return createStripeCheckoutSession(params);

    case "RAZORPAY":
      return createRazorpayOrder(params);

    case "LEMON_SQUEEZY":
      // TODO: Implement when LemonSqueezy KYC is complete
      throw new PaymentError(
        "LemonSqueezy integration not yet available - KYC pending",
        "NOT_IMPLEMENTED",
        "LEMON_SQUEEZY",
      );

    case "XFLOW":
      // TODO: Implement when XFlow is ready for production
      throw new PaymentError(
        "XFlow integration not yet available",
        "NOT_IMPLEMENTED",
        "XFLOW",
      );

    default:
      throw new PaymentError(
        `Unsupported payment gateway: ${paymentGateway}`,
        "UNSUPPORTED_GATEWAY",
      );
  }
}

/**
 * Cancel a payment intent
 */
export async function cancelPaymentIntent(
  paymentIntentId: string,
  reason: string = "requested_by_customer",
): Promise<void> {
  // Handle mock payments
  if (isMockPaymentId(paymentIntentId)) {
    return cancelMockPayment(paymentIntentId);
  }

  // Route based on payment ID format
  if (paymentIntentId.startsWith("cs_") || paymentIntentId.startsWith("pi_")) {
    return cancelStripePayment(paymentIntentId, reason);
  }

  if (paymentIntentId.startsWith("order_")) {
    return cancelRazorpayOrder(paymentIntentId);
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

  // Route based on payment ID format
  if (paymentIntentId.startsWith("pi_") || paymentIntentId.startsWith("cs_")) {
    return createStripeRefund(params);
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
  switch (gateway) {
    case "STRIPE":
      return getStripeRefund(refundId);

    case "RAZORPAY":
      return getRazorpayRefund(refundId);

    default:
      throw new PaymentError(
        `Refund retrieval not supported for: ${gateway}`,
        "NOT_SUPPORTED",
        gateway,
      );
  }
}

/**
 * List refunds for a payment
 */
export async function listRefunds(
  paymentIntentId: string,
  gateway: PaymentGateway,
  limit: number = 10,
): Promise<RefundResult[]> {
  switch (gateway) {
    case "STRIPE":
      return listStripeRefunds(paymentIntentId, limit);

    case "RAZORPAY":
      return listRazorpayRefunds(paymentIntentId, limit);

    default:
      throw new PaymentError(
        `Refund listing not supported for: ${gateway}`,
        "NOT_SUPPORTED",
        gateway,
      );
  }
}

// ============================================================================
// Unified Dispute Operations
// ============================================================================

/**
 * Get dispute details
 * Note: Only Stripe supports direct dispute API access
 * Razorpay disputes are handled via webhooks only
 */
export async function getDispute(
  disputeId: string,
  gateway: PaymentGateway,
): Promise<DisputeResult> {
  switch (gateway) {
    case "STRIPE":
      return getStripeDispute(disputeId);

    case "RAZORPAY":
      throw new PaymentError(
        "Razorpay disputes can only be accessed via webhooks",
        "NOT_SUPPORTED",
        "RAZORPAY",
      );

    default:
      throw new PaymentError(
        `Dispute retrieval not supported for: ${gateway}`,
        "NOT_SUPPORTED",
        gateway,
      );
  }
}

/**
 * Submit evidence for a dispute
 */
export async function submitDisputeEvidence(
  params: DisputeParams,
  gateway: PaymentGateway,
): Promise<DisputeResult> {
  switch (gateway) {
    case "STRIPE":
      return submitStripeDisputeEvidence(params);

    case "RAZORPAY":
      throw new PaymentError(
        "Razorpay dispute evidence must be submitted through their dashboard",
        "NOT_SUPPORTED",
        "RAZORPAY",
      );

    default:
      throw new PaymentError(
        `Dispute evidence submission not supported for: ${gateway}`,
        "NOT_SUPPORTED",
        gateway,
      );
  }
}

/**
 * List all disputes (admin only)
 */
export async function listDisputes(
  gateway: PaymentGateway,
  limit: number = 10,
): Promise<DisputeResult[]> {
  switch (gateway) {
    case "STRIPE":
      return listStripeDisputes(limit);

    case "RAZORPAY":
      throw new PaymentError(
        "Razorpay disputes can only be accessed via webhooks",
        "NOT_SUPPORTED",
        "RAZORPAY",
      );

    default:
      throw new PaymentError(
        `Dispute listing not supported for: ${gateway}`,
        "NOT_SUPPORTED",
        gateway,
      );
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine payment gateway from payment intent ID
 */
export function getPaymentGateway(paymentIntentId: string): PaymentGateway {
  if (isMockPaymentId(paymentIntentId)) {
    // Extract gateway from mock ID
    if (paymentIntentId.includes("cs_mock")) return "STRIPE";
    if (paymentIntentId.includes("order_mock")) return "RAZORPAY";
    if (paymentIntentId.includes("ls_mock")) return "LEMON_SQUEEZY";
    if (paymentIntentId.includes("xf_mock")) return "XFLOW";
  }

  if (paymentIntentId.startsWith("cs_") || paymentIntentId.startsWith("pi_")) {
    return "STRIPE";
  }

  if (
    paymentIntentId.startsWith("order_") ||
    paymentIntentId.startsWith("pay_")
  ) {
    return "RAZORPAY";
  }

  throw new PaymentError(
    `Cannot determine gateway for payment: ${paymentIntentId}`,
    "UNKNOWN_GATEWAY",
  );
}

/**
 * Convert amount to smallest currency unit
 */
export function convertAmountToSmallestUnit(
  amount: number,
  currency: string,
): number {
  const multipliers: Record<string, number> = {
    USD: 100, // cents
    EUR: 100, // cents
    GBP: 100, // pence
    JPY: 1, // yen has no smaller unit
    INR: 100, // paise
    NGN: 100, // kobo
  };

  return Math.round(amount * (multipliers[currency] || 100));
}

/**
 * Convert from smallest currency unit to base unit
 */
export function convertAmountFromSmallestUnit(
  amount: number,
  currency: string,
): number {
  const multipliers: Record<string, number> = {
    USD: 100,
    EUR: 100,
    GBP: 100,
    JPY: 1,
    INR: 100,
    NGN: 100,
  };

  return amount / (multipliers[currency] || 100);
}
