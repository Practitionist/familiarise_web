import { PaymentGateway, RefundStatus, DisputeStatus } from "@prisma/client";

/**
 * Common payment types and interfaces for all payment gateways
 *
 * #781 §A — `currency` here is deliberately `string`: these types face the
 * gateways, which speak free-form ISO codes (incl. display currencies the
 * Currency enum doesn't model). Database money rows store the Currency enum;
 * every row-write must coerce through toCurrencyEnum() (currency-guards.ts).
 */

// ============================================================================
// Payment Intent Types
// ============================================================================

export interface PaymentIntentParams {
  amount: number; // Amount in base currency (e.g., 100.00 for $100)
  currency: string;
  // Booking checkouts set appointmentId/appointmentType; standalone goods
  // (#366 recording_purchase) have no booking context and omit them. Kept as
  // a flat Record because Razorpay/Stripe metadata params reject
  // optional-property index signatures (`string | undefined`).
  metadata: Record<string, string>;
  paymentGateway: PaymentGateway;
  isMockPayment?: boolean; // For development: skip actual gateway calls
}

export interface PaymentIntent {
  id: string; // Gateway-specific payment/order ID
  client_secret: string; // Secret or URL for client-side completion
  amount: number;
  currency: string;
  status: string;
}

// ============================================================================
// Refund Types
// ============================================================================

export interface RefundParams {
  paymentIntentId: string; // Original payment ID
  amount?: number; // Optional partial refund amount (in base currency)
  reason?: string; // Reason for refund
  metadata?: Record<string, string>;
  // Stable per *logical* refund, not per attempt — a retry must reuse it so the
  // gateway returns the original refund instead of issuing a second one. Must
  // NOT be derived from paymentId+amount: two legitimate partial refunds of the
  // same amount would collide and the second would silently under-refund.
  idempotencyKey?: string;
}

export interface RefundResult {
  refundId: string; // Gateway-specific refund ID
  amount: number;
  currency: string;
  status: RefundStatus;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Dispute Types
// ============================================================================

export interface DisputeEvidence {
  // Common evidence fields
  customerName?: string;
  customerEmailAddress?: string;
  customerPurchaseIp?: string;

  // Cancellation-related
  cancellationPolicy?: string;
  cancellationPolicyDisclosure?: string;
  cancellationRebuttal?: string;

  // Duplicate charge
  duplicateChargeId?: string;
  duplicateChargeExplanation?: string;
  duplicateChargeDocumentation?: string;

  // Product/Service description
  productDescription?: string;
  receipt?: string;

  // Customer communication
  customerCommunication?: string;

  // Uncategorized
  uncategorizedText?: string;
  uncategorizedFile?: string;
}

export interface DisputeParams {
  disputeId: string;
  evidence: DisputeEvidence;
}

export interface DisputeResult {
  disputeId: string;
  status: DisputeStatus;
  evidence?: Record<string, unknown>;
  isChargeRefundable: boolean;
  dueBy?: Date;
}

// ============================================================================
// Helper Types
// ============================================================================

/** Supported currency codes for payment gateway amount conversion. */
type SupportedCurrency =
  | "USD"
  | "EUR"
  | "GBP"
  | "JPY"
  | "INR"
  | "AUD"
  | "CAD"
  | "SGD"
  | "AED"
  | "NGN";

export const CURRENCY_MULTIPLIERS: Record<SupportedCurrency, number> = {
  USD: 100, // cents
  EUR: 100, // cents
  GBP: 100, // pence
  JPY: 1, // yen has no smaller unit
  INR: 100, // paise
  AUD: 100, // cents
  CAD: 100, // cents
  SGD: 100, // cents
  AED: 100, // fils
  NGN: 100, // kobo
};

// ============================================================================
// Error Types
// ============================================================================

export class PaymentError extends Error {
  constructor(
    message: string,
    public code: string,
    public gateway?: PaymentGateway,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export class RefundError extends Error {
  constructor(
    message: string,
    public code: string,
    public gateway?: PaymentGateway,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = "RefundError";
  }
}

export class DisputeError extends Error {
  constructor(
    message: string,
    public code: string,
    public gateway?: PaymentGateway,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = "DisputeError";
  }
}
