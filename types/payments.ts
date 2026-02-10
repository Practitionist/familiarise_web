/**
 * Shared types for Payment, Refund, Dispute, and Earnings API responses.
 * Used by admin/staff payment, refund, payout, and dispute pages.
 */

// ─── Payment List (admin/payments, staff/payments) ─────────────────
export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  receiptUrl: string | null;
  paymentMethod: string;
  paymentIntent: string;
  paymentGateway: string;
  paymentStatus: string;
  isMockPayment?: boolean;
  createdAt: string;
  appointment: {
    appointmentType: string;
  } | null;
}

export interface PaymentListResponse {
  payments: Payment[];
  total: number;
  page: number;
  totalPages: number;
}

// ─── Payment Detail (admin/payments/[paymentId]) ───────────────────
export interface PaymentDetailRefund {
  id: string;
  refundId: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  createdAt: string;
}

export interface PaymentDetailDispute {
  id: string;
  disputeId: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface PaymentDetail {
  id: string;
  amount: number;
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
    appointmentType: string;
  } | null;
  discountCode: {
    code: string;
    discountType: string;
    discountValue: number;
  } | null;
  refunds: PaymentDetailRefund[];
  disputes: PaymentDetailDispute[];
}

// ─── Refund List (admin/refunds, staff/refunds) ────────────────────
export interface Refund {
  id: string;
  refundId?: string;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
  paymentGateway?: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

export interface RefundListResponse {
  refunds: Refund[];
  total: number;
  page: number;
  limit?: number;
  totalPages: number;
}

// ─── Dispute List (admin/disputes) ─────────────────────────────────
export interface Dispute {
  id: string;
  disputeId: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  dueBy: string | null;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

export interface DisputeListResponse {
  disputes: Dispute[];
  total: number;
  page: number;
  totalPages: number;
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
    appointmentType: string;
  } | null;
}

export interface RecentRefund {
  id: string;
  amount: number;
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
export interface EarningsStats {
  pending: { count: number; consultantShare: number; platformFee: number };
  ready: { count: number; consultantShare: number; platformFee: number };
  paid: { count: number; consultantShare: number; platformFee: number };
  held: { count: number; consultantShare: number; platformFee: number };
  refunded: { count: number; consultantShare: number; platformFee: number };
  totalPlatformRevenue: number;
}

export interface Earning {
  id: string;
  consultantProfile: {
    user: { name: string; email: string };
  };
  grossAmount: number;
  platformFee: number;
  consultantShare: number;
  status: string;
  holdUntil: string;
  createdAt: string;
}
