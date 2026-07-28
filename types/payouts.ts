/**
 * Shared types for Payout API responses.
 * Used by admin/payouts (pending, processing, completed) and staff/payouts pages.
 */

export interface Payout {
  id: string;
  consultantName: string;
  consultantEmail: string;
  amount: number;
  currency: string;
  method: string;
  provider: string;
  earningsCount: number;
  createdAt: string;
  status: string;
  batchId?: string;
  providerPayoutId?: string;
  approvedAt?: string;
  approvedBy?: string;
  processedAt?: string;
  failureReason?: string;
  /** #863 — MSME §43B(h) statutory pay-by date; null for non-MSME vendors. */
  mustPayByDate?: string | null;
}
