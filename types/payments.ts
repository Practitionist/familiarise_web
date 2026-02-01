/**
 * Shared types for Payment, Refund, and Earnings API responses.
 * Used by admin/staff payment, refund, and payout pages.
 */

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
  createdAt: string;
  appointment: {
    appointmentType: string;
  } | null;
}

export interface Refund {
  id: string;
  refundId?: string;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
  paymentGateway?: string;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

export interface PaymentListResponse {
  payments: Payment[];
  total: number;
  page: number;
  totalPages: number;
}

export interface RefundListResponse {
  refunds: Refund[];
  total: number;
  page: number;
  limit?: number;
  totalPages: number;
}

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
