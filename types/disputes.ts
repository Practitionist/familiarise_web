/**
 * Shared types for Dispute API responses.
 * Used by staff/disputes and staff/disputes/[disputeId] pages.
 */

export interface Dispute {
  id: string;
  disputeId: string;
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
  urgentDisputes: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DisputeDetails {
  id: string;
  disputeId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  dueBy: string | null;
  evidence: string | null;
  evidenceSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payment: {
    id: string;
    paymentIntent: string;
    amount: number;
    currency: string;
    paymentMethod: string | null;
    createdAt: string;
    user: {
      id: string;
      name: string | null;
      email: string;
    };
  } | null;
}
