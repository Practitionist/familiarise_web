import * as Sentry from "@sentry/nextjs";
import Razorpay from "razorpay";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  PaymentError,
  RefundError,
} from "./types";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";

// ============================================================================
// Razorpay Client Initialization
// ============================================================================

// L2 FIX: Removed module-load console.warn — per-call errors are more actionable
const initializeRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
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

// After paise migration, all amounts in the DB are already in smallest currency unit (paise/cents).
// No conversion needed — amounts pass through directly to Razorpay.

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

  // BUG-C: Validate amount is positive before creating payment order
  if (amount <= 0) {
    throw new PaymentError(
      "Payment amount must be greater than zero",
      "INVALID_AMOUNT",
      "RAZORPAY",
    );
  }

  try {
    const order = await Sentry.startSpan(
      { op: "http.client", name: "razorpay.createOrder" },
      () =>
        razorpayClient.orders.create({
          amount: amount, // already in smallest currency unit (paise)
          currency,
          notes: metadata,
          // PM-11 — Date.now() collides for two orders in the same ms; the uuid
          // suffix keeps the receipt unique so Razorpay doesn't reject the dupe.
          receipt: `receipt_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 8)}`,
        }),
    );

    return {
      id: order.id,
      client_secret: order.id, // Razorpay uses order ID as client secret
      amount: Number(order.amount), // already in smallest currency unit
      currency: order.currency,
      status: order.status,
    };
  } catch (error) {
    console.error("Razorpay order creation failed:", error);
    Sentry.captureException(error, {
      tags: { subsystem: "payments", provider: "razorpay", expected: "false" },
      contexts: { payment: { amount, currency } },
    });
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
      console.log(
        `✅ Razorpay order had no payments, safe to ignore: ${orderId}`,
      );
      return;
    }
    console.warn(
      `⚠️ Cannot cancel Razorpay order with existing payments: ${orderId}`,
    );
  } catch (error) {
    // If we can't fetch payments, assume it's safe to ignore — best-effort
    // cancel, and a stray order with no payment costs nothing.
    console.log(
      `✅ Razorpay order fetch failed (likely safe to ignore): ${orderId}`,
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "payments", provider: "razorpay", expected: "true" },
        level: "info",
      },
    );
  }
}

// ============================================================================
// Refund Operations
// ============================================================================

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const REFUND_TIMEOUT_MS = 30_000;

/** Razorpay: at least 10 chars, only letters, digits, hyphens and underscores. */
const IDEMPOTENCY_KEY_MIN_LENGTH = 10;

type RazorpayRefundResponse = {
  id: string;
  amount: number;
  currency?: string;
  status: string | null;
  notes?: Record<string, unknown>;
};

/**
 * POST /v1/payments/:id/refund over raw HTTP instead of the SDK.
 *
 * `X-Refund-Idempotency` is the only thing between a network-error retry and a
 * second refund landing on the customer's card, and razorpay-node cannot send
 * it at all: `getValidHeaders()` whitelists exactly `X-Razorpay-Account` and
 * `Content-Type` and silently drops everything else, so the header is
 * unreachable per-request *and* per-client. Raw HTTP is the only path.
 * https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/
 *
 * The header is sent only when the caller supplies a key. Deriving one from
 * paymentId+amount would make two legitimate partial refunds of equal amount
 * collide, and the second would silently return the first refund.
 */
async function postRefund({
  paymentId,
  amount,
  notes,
  idempotencyKey,
}: {
  paymentId: string;
  amount?: number;
  notes: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<RazorpayRefundResponse> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    throw new RefundError(
      "Razorpay credentials missing - cannot process refund",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  // A caller that supplies a key is asking for exactly-once semantics. If the
  // key doesn't survive sanitization we must NOT quietly send the request
  // without the header — that downgrades a refund to at-least-once delivery
  // against a customer's card, with no signal that it happened. Refuse instead;
  // every real caller passes `Refund.id` (a uuid), so this only fires on a
  // programming error.
  if (idempotencyKey !== undefined) {
    const sanitizedKey = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "");
    if (sanitizedKey.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
      throw new RefundError(
        `Refund idempotency key "${idempotencyKey}" is unusable after sanitization ` +
          `(${sanitizedKey.length} of the required ${IDEMPOTENCY_KEY_MIN_LENGTH} chars). ` +
          `Refusing to issue a non-idempotent refund.`,
        "INVALID_IDEMPOTENCY_KEY",
        "RAZORPAY",
      );
    }
    headers["X-Refund-Idempotency"] = sanitizedKey;
  }

  const body = JSON.stringify({ ...(amount ? { amount } : {}), notes });
  const url = `${RAZORPAY_API_BASE}/payments/${encodeURIComponent(paymentId)}/refund`;

  // Razorpay answers a *concurrent* duplicate of the same key with 409 while the
  // original is still in flight; once it settles the same key returns the
  // original refund. One bounded retry converts that race into the right answer.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
    });

    if (res.ok) {
      return (await res.json()) as RazorpayRefundResponse;
    }

    if (res.status === 409 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    // Razorpay's error body is `{ error: { code, description } }` — the shape
    // handleRazorpayRefundError already parses, so throw it through unchanged.
    const parsed = await res.json().catch(() => null);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      throw parsed;
    }
    throw new RefundError(
      `Razorpay refund failed with HTTP ${res.status}`,
      res.status === 409 ? "REFUND_IN_FLIGHT" : "UNKNOWN_ERROR",
      "RAZORPAY",
    );
  }
}

/**
 * Create a refund for a Razorpay payment
 * Note: Razorpay refunds are created on payment IDs, not order IDs
 */
export async function createRazorpayRefund({
  paymentIntentId,
  amount,
  reason,
  metadata,
  idempotencyKey,
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
    const payments = await razorpayClient.orders.fetchPayments(paymentIntentId);

    if (payments.count === 0) {
      throw new RefundError(
        "No payment found for this order",
        "NO_PAYMENT_FOUND",
        "RAZORPAY",
      );
    }

    // PM-12 — an order can carry failed attempts before the captured one;
    // items[0] is creation-ordered, so refunding it blindly can target a
    // non-captured payment. Prefer the captured payment.
    const payment =
      payments.items.find((p) => p.status === "captured") ?? payments.items[0];

    // Create refund on the payment. Raw HTTP, not the SDK — see postRefund.
    const refund = await postRefund({
      paymentId: payment.id,
      amount: amount || undefined, // already in smallest currency unit (paise)
      notes: {
        reason: reason || "requested_by_customer",
        ...metadata,
      },
      idempotencyKey,
    });

    return {
      refundId: refund.id,
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes
        ? (refund.notes as Record<string, unknown>)
        : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund creation failed:", error);
    // NO_PAYMENT_FOUND/etc are our own pre-gateway validation (thrown above in
    // this same try), not a gateway fault — tag by origin so the dashboard
    // doesn't conflate "Razorpay is down" with "this order has no payment".
    const isModelledValidation =
      error instanceof RefundError && error.code !== "UNKNOWN_ERROR";
    Sentry.captureException(error, {
      tags: {
        subsystem: "payments",
        provider: "razorpay",
        expected: isModelledValidation ? "true" : "false",
      },
      level: isModelledValidation ? "info" : "error",
    });
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
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes
        ? (refund.notes as Record<string, unknown>)
        : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund retrieval failed:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "payments", provider: "razorpay", expected: "false" },
      },
    );
    throw handleRazorpayRefundError(error);
  }
}

/**
 * List all refunds for a payment
 * Note: This function receives an orderId, not a paymentId
 */
export async function listRazorpayRefunds(
  orderId: string,
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
    // First, get the payment ID from the order ID
    const payments = await razorpayClient.orders.fetchPayments(orderId);
    if (payments.count === 0) {
      return []; // No payments for this order, so no refunds
    }
    // PM-12 — prefer the captured payment over a failed earlier attempt.
    const paymentId = (
      payments.items.find((p) => p.status === "captured") ?? payments.items[0]
    ).id;

    // Fetch refunds for the specific payment using the SDK method
    const refundsResponse = await razorpayClient.payments.fetchMultipleRefund(
      paymentId,
      {
        count: limit,
      },
    );

    return refundsResponse.items.map((refund) => ({
      refundId: refund.id,
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes || undefined,
    }));
  } catch (error) {
    console.error("Razorpay refunds list failed:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "payments", provider: "razorpay", expected: "false" },
      },
    );
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
  // Already classified upstream (NO_PAYMENT_FOUND, REFUND_IN_FLIGHT,
  // RAZORPAY_NOT_INITIALIZED) — re-wrapping would flatten it to UNKNOWN_ERROR
  // and lose the code callers branch on.
  if (error instanceof RefundError) {
    return error;
  }

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
