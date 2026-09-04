import { reportSentryError } from "@/lib/observability/report";
import Stripe from "stripe";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  DisputeParams,
  DisputeResult,
  PaymentError,
  RefundError,
  DisputeError,
} from "./types";
import { RefundStatus, DisputeStatus } from "@prisma/client";
import { getAppUrl } from "@/lib/url";
import { assertInrSettlement } from "@/lib/payments/validation/currency-guards";

/**
 * Convert Stripe's complex Evidence object to a plain record.
 * Avoids repeating `as unknown as Record<string, unknown>` at every call site.
 */
function toEvidenceRecord(
  evidence: Stripe.Dispute.Evidence,
): Record<string, unknown> {
  return evidence as unknown as Record<string, unknown>;
}

// ============================================================================
// Stripe Client Initialization
// ============================================================================

const initializeStripeClient = () => {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    console.warn("STRIPE_SECRET_KEY not found in environment variables");
    return null;
  }
  return new Stripe(apiKey, {
    apiVersion: "2026-02-25.clover",
  });
};

// Lazy singleton (lib/email.ts getResendClient convention). Instantiating at
// module scope put the SDK constructor on every cold boot of any route whose
// import graph reaches this file. MEASURED 2026-08-23 (#1221): this does NOT
// shrink the #1124 concurrent-instance event-loop stall — that reproduced
// 12/12 at full strength on a build carrying exactly this change. Keep the
// lazy pattern as boot hygiene; do not cite it as stall mitigation.
// `undefined` = not yet attempted; `null` = attempted and missing credentials
// (cached, like the original module-scope init, so the warning logs once).
// `undefined` = not yet attempted; `null` = attempted and missing credentials
// (cached, like the original module-scope init, so the warning logs once).
let stripeClientInstance: Stripe | null | undefined;

export function getStripeClient(): Stripe | null {
  if (stripeClientInstance === undefined) {
    stripeClientInstance = initializeStripeClient();
  }
  return stripeClientInstance;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the base URL for payment redirects
 */
const getBaseUrl = () => {
  return getAppUrl();
};

// After paise migration, all amounts in the DB are already in smallest currency unit (paise/cents).
// No conversion needed for INR. For non-INR currencies, the amount from checkout is already
// in the target currency's smallest unit via the checkout calculation.

// ============================================================================
// Checkout/Payment Intent Operations
// ============================================================================

/**
 * Create a Stripe Checkout Session
 */
export async function createStripeCheckoutSession({
  amount,
  currency,
  metadata,
}: PaymentIntentParams): Promise<PaymentIntent> {
  // #1396 — same boundary as the Razorpay sibling, and equally the first
  // statement here. `unit_amount` below is INR paise no matter what this
  // argument says, so lower-casing an unvalidated code into
  // `price_data.currency` would price the order in a foreign subunit.
  // #1396 — use the canonical code the guard just normalised, not the raw
  // (possibly padded/lowercased) input.
  const settlementCurrency = assertInrSettlement(
    currency,
    "create a Stripe checkout session",
    "STRIPE",
  );

  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new PaymentError(
      "Stripe client not initialized - check STRIPE_SECRET_KEY environment variable",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  // BUG-C: Validate amount is positive before creating payment intent
  if (amount <= 0) {
    throw new PaymentError(
      "Payment amount must be greater than zero",
      "INVALID_AMOUNT",
      "STRIPE",
    );
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: settlementCurrency.toLowerCase(),
            product_data: {
              name: `${metadata.appointmentType} Appointment`,
              description: `Appointment booking for ${metadata.appointmentType}`,
            },
            unit_amount: amount, // already in smallest currency unit (paise/cents)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${getBaseUrl()}/checkout/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getBaseUrl()}/checkout/checkout-failure`,
      metadata,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
    });

    return {
      id: session.id,
      client_secret: session.url!, // Checkout URL
      amount,
      currency,
      status: session.status || "open",
    };
  } catch (error) {
    console.error("Stripe checkout session creation failed:", error);
    // A declined/invalid card is an ANSWER the gateway gave us, not a fault —
    // tag it separately so the dashboard doesn't read "Stripe is down" for
    // routine card declines.
    const isCardDecline =
      error instanceof Stripe.errors.StripeError &&
      error.type === "StripeCardError";
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
      expected: isCardDecline,
      contexts: { payment: { amount, currency } },
    });
    throw handleStripeError(error);
  }
}

/**
 * Cancel a Stripe checkout session or payment intent
 */
export async function cancelStripePayment(
  paymentIntentId: string,
  reason: string = "requested_by_customer",
): Promise<void> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    console.warn("Stripe client not initialized - cannot cancel payment");
    return;
  }

  try {
    if (paymentIntentId.startsWith("cs_")) {
      // Checkout session - expire it
      await stripeClient.checkout.sessions.expire(paymentIntentId);
      console.log(`✅ Stripe checkout session expired: ${paymentIntentId}`);
    } else if (paymentIntentId.startsWith("pi_")) {
      // Payment intent - cancel it
      await stripeClient.paymentIntents.cancel(paymentIntentId, {
        cancellation_reason:
          reason === "requested_by_customer"
            ? "requested_by_customer"
            : "abandoned",
      });
      console.log(`✅ Stripe payment intent cancelled: ${paymentIntentId}`);
    }
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      // Already expired/cancelled is fine
      if (
        error.code === "resource_missing" ||
        error.message.includes("already")
      ) {
        console.log(
          `✅ Payment was already expired/cancelled: ${paymentIntentId}`,
        );
        reportSentryError(error, {
          subsystem: "payments",
          tags: { provider: "stripe" },
          expected: true,
        });
        return;
      }
    }
    console.error(`Failed to cancel Stripe payment ${paymentIntentId}:`, error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
  }
}

// ============================================================================
// Refund Operations
// ============================================================================

/**
 * Create a refund for a Stripe payment
 */
export async function createStripeRefund({
  paymentIntentId,
  amount,
  reason,
  metadata,
}: RefundParams): Promise<RefundResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized - cannot process refund",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    // Fetch the payment intent to get the currency
    const paymentIntent =
      await stripeClient.paymentIntents.retrieve(paymentIntentId);
    const _currency = paymentIntent.currency;

    const refund = await stripeClient.refunds.create({
      payment_intent: paymentIntentId,
      amount: amount || undefined, // already in smallest currency unit (paise/cents)
      reason: mapRefundReason(reason),
      metadata,
    });

    return {
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    };
  } catch (error) {
    console.error("Stripe refund creation failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

/**
 * Get refund status from Stripe
 */
export async function getStripeRefund(refundId: string): Promise<RefundResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const refund = await stripeClient.refunds.retrieve(refundId);

    return {
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    };
  } catch (error) {
    console.error("Stripe refund retrieval failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

/**
 * List all refunds for a payment intent
 */
export async function listStripeRefunds(
  paymentIntentId: string,
  limit: number = 10,
): Promise<RefundResult[]> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const refunds = await stripeClient.refunds.list({
      payment_intent: paymentIntentId,
      limit,
    });

    return refunds.data.map((refund) => ({
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    }));
  } catch (error) {
    console.error("Stripe refunds list failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

// ============================================================================
// Dispute Operations
// ============================================================================

/**
 * Get dispute details from Stripe
 */
export async function getStripeDispute(
  disputeId: string,
): Promise<DisputeResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const dispute = await stripeClient.disputes.retrieve(disputeId);

    return {
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    };
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      // Only log message for cleaner output, not the full error object
      console.error(
        `Stripe dispute retrieval failed: ${error.message} (code: ${error.code})`,
      );
    } else {
      console.error("Stripe dispute retrieval failed:", error);
    }
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

/**
 * Submit evidence for a Stripe dispute
 */
export async function submitStripeDisputeEvidence({
  disputeId,
  evidence,
}: DisputeParams): Promise<DisputeResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const dispute = await stripeClient.disputes.update(disputeId, {
      evidence: {
        customer_name: evidence.customerName,
        customer_email_address: evidence.customerEmailAddress,
        customer_purchase_ip: evidence.customerPurchaseIp,
        cancellation_policy: evidence.cancellationPolicy,
        cancellation_policy_disclosure: evidence.cancellationPolicyDisclosure,
        cancellation_rebuttal: evidence.cancellationRebuttal,
        duplicate_charge_id: evidence.duplicateChargeId,
        duplicate_charge_explanation: evidence.duplicateChargeExplanation,
        duplicate_charge_documentation: evidence.duplicateChargeDocumentation,
        product_description: evidence.productDescription,
        receipt: evidence.receipt,
        customer_communication: evidence.customerCommunication,
        uncategorized_text: evidence.uncategorizedText,
        uncategorized_file: evidence.uncategorizedFile,
      },
    });

    // Stripe auto-submits evidence to the card network after disputes.update().
    // Do NOT call disputes.close() — that ACCEPTS/concedes the dispute!

    return {
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    };
  } catch (error) {
    console.error("Stripe dispute evidence submission failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

/**
 * List all disputes (for admin dashboard)
 */
export async function listStripeDisputes(
  limit: number = 10,
): Promise<DisputeResult[]> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const disputes = await stripeClient.disputes.list({ limit });

    return disputes.data.map((dispute) => ({
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    }));
  } catch (error) {
    console.error("Stripe disputes list failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

// ============================================================================
// Mapping Helpers
// ============================================================================

function mapRefundReason(
  reason?: string,
): "duplicate" | "fraudulent" | "requested_by_customer" | undefined {
  if (!reason) return "requested_by_customer";
  if (reason.includes("duplicate")) return "duplicate";
  if (reason.includes("fraud")) return "fraudulent";
  return "requested_by_customer";
}

function mapStripeRefundStatus(status: string | null): RefundStatus {
  switch (status) {
    case "succeeded":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELLED";
    default:
      return "PENDING";
  }
}

function mapStripeDisputeStatus(status: string): DisputeStatus {
  switch (status) {
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
// Error Handlers
// ============================================================================

function handleStripeError(error: unknown): PaymentError {
  if (error instanceof Stripe.errors.StripeError) {
    if (error.type === "StripeAuthenticationError") {
      return new PaymentError(
        "Authentication failed - Invalid Stripe API key",
        "AUTH_ERROR",
        "STRIPE",
        error,
      );
    }
    if (error.type === "StripeCardError") {
      return new PaymentError(
        error.message || "Card was declined",
        "CARD_ERROR",
        "STRIPE",
        error,
      );
    }
    if (error.type === "StripeRateLimitError") {
      return new PaymentError(
        "Too many requests - please try again later",
        "RATE_LIMIT",
        "STRIPE",
        error,
      );
    }
  }
  return new PaymentError(
    "Failed to create payment intent",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}

function handleStripeRefundError(error: unknown): RefundError {
  if (error instanceof Stripe.errors.StripeError) {
    return new RefundError(
      error.message || "Refund failed",
      error.code || "UNKNOWN_ERROR",
      "STRIPE",
      error,
    );
  }
  return new RefundError(
    "Failed to process refund",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}

function handleStripeDisputeError(error: unknown): DisputeError {
  if (error instanceof Stripe.errors.StripeError) {
    return new DisputeError(
      error.message || "Dispute operation failed",
      error.code || "UNKNOWN_ERROR",
      "STRIPE",
      error,
    );
  }
  return new DisputeError(
    "Failed to process dispute",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}
