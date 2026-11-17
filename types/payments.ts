/**
 * Shared types for Payment, Refund, Dispute, and Earnings API responses.
 * Used by admin/staff payment, refund, payout, and dispute pages.
 */

import type { AppointmentsType } from "@prisma/client";

import type { BookingRef } from "@/lib/data/booking-title";

// ─── Payment, refund and dispute lists ─────────────────────────────
// Their rows are Zod schemas in lib/backoffice/money-list-schemas.ts, parsed by
// the screens, so no hand-written interface can drift from the payload.

// ─── B2C tax invoice (#1365) ───────────────────────────────────────
/** Summary of the statutory consumer tax invoice attached to a payment. The
 *  PDF itself is fetched from /api/payments/[paymentId]/invoice/pdf, which
 *  authorises the caller and returns a short-lived signed URL. */
export interface PaymentConsumerInvoice {
  id: string;
  invoiceNumber: string;
  issuedAt: string;
}

// ─── Payment Detail (admin/payments/[paymentId]) ───────────────────
export interface PaymentDetailRefund {
  id: string;
  refundId: string | null;
  /** `Refund.amountPaise`. Declaring `amount` here rendered "£NaN" on the
   *  payment detail page for every refund and dispute — see [PaymentDetailDispute]. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  createdAt: string;
}

export interface PaymentDetailDispute {
  id: string;
  /** Non-null in the schema (`@unique`), but kept nullable here so the UI
   *  keeps its existing guards; narrowing it is a separate change. */
  disputeId: string | null;
  /** `Dispute.amountPaise` — neither money model has ever had an `amount`. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface PaymentDetail {
  id: string;
  amount: number;
  originalAmount: number;
  taxAmount: number;
  /** Pre-tax referral welcome discount; null when the order had none. */
  welcomeDiscountPaise: number | null;
  /** Funding legs, so the referral-credit share can be told from the code discount. */
  legs: { source: string; amountPaise: number }[];
  currency: string;
  description: string | null;
  receiptUrl: string | null;
  paymentMethod: string;
  paymentIntent: string;
  paymentGateway: string;
  paymentStatus: string;
  isMockPayment?: boolean;
  expiresAt: string | null;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  appointment: {
    id: string;
    appointmentType: AppointmentsType;
  } | null;
  /** The booking's plan title, beside its id and kind. */
  booking: BookingRef | null;
  discountCode: {
    code: string;
    discountType: string;
    discountValue: number;
  } | null;
  refunds: PaymentDetailRefund[];
  disputes: PaymentDetailDispute[];
  consumerInvoice?: PaymentConsumerInvoice | null;
  /** Set on a digital product sale: the evidence shown before a refund. */
  digitalProductPurchase?: PaymentDigitalProductPurchase | null;
}

export interface PaymentDigitalProductPurchase {
  status: string;
  firstDownloadedAt: string | null;
  product: { title: string };
  _count: { downloads: number };
}

// ─── Admin Dashboard Stats (admin/home) ────────────────────────────
export interface RecentPayment {
  id: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentGateway: string;
  createdAt: string;
  appointment: {
    appointmentType: AppointmentsType;
  } | null;
}

export interface RecentRefund {
  id: string;
  /**
   * `Refund` stores money in `amountPaise`, and the operator-stats query
   * selects exactly that. This interface said `amount` — a field the payload
   * has never carried — so the admin dashboard's Recent Refunds list formatted
   * `undefined` and rendered a literal "₹NaN". Same defect class the refunds
   * and disputes tables already had; the drift test now covers this one too.
   */
  amountPaise: number;
  currency: string;
  status: string;
  paymentGateway: string;
  createdAt: string;
}

export interface AdminDashboardStats {
  totalPayments: number;
  totalPaymentsValue: number;
  pendingPayments: number;
  pendingPaymentsValue: number;
  totalRefunds: number;
  totalRefundsValue: number;
  activeDisputes: number;
  totalDisputes: number;
  recentPayments: RecentPayment[];
  recentRefunds: RecentRefund[];
  gatewayStats: Record<string, { count: number }>;
}

// ─── Earnings (admin/payouts) ──────────────────────────────────────
export interface Earning {
  id: string;
  consultantProfile: {
    user: { name: string; email: string };
  };
  grossAmount: number;
  platformFeePaise: number;
  consultantSharePaise: number;
  status: string;
  holdUntil: string;
  createdAt: string;
}
