/**
 * Shared types for Dispute API responses.
 * Used by admin/disputes, staff/disputes and their detail pages.
 */

import type { BookingRef } from "@/lib/data/booking-title";

/**
 * Represents a JSON value from Prisma's Json type.
 * Used for fields like `evidence` and `metadata` that store arbitrary JSON.
 */
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DisputeDetails {
  id: string;
  disputeId: string;
  /** Paise. Was declared as `amount`, which the API never returned. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  paymentId: string;
  dueBy: string | null;
  isChargeRefundable: boolean;
  /** Present only for viewers holding `disputes.manage`. */
  evidence?: JsonValue | null;
  evidenceSubmittedAt: string | null;
  assignedToUserId: string | null;
  assignedTo: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  payment: {
    id: string;
    paymentIntent: string;
    paymentStatus: string;
    amount: number;
    currency: string;
    paymentMethod: string | null;
    createdAt: string;
    user: {
      id: string;
      name: string | null;
      /** Present only for viewers holding `disputes.manage`. */
      email?: string;
    };
    /** The booking's plan title, beside its id and kind. */
    booking: BookingRef | null;
  } | null;
  evidencePack?: DisputeEvidencePack;
}

export interface DisputeEvidencePack {
  booking: {
    appointmentId: string;
    appointmentType: string;
    createdAt: string;
  } | null;
  occurrences: {
    total: number;
    completedCount: number;
    outcomes: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
      completionStatus: string;
      outcome: string | null;
    }>;
  };
  attendance: {
    presentCount: number;
    recordsFound: boolean;
    /** Sessions whose Stream attendance record is not stored yet. */
    pendingSessions: number;
    summary: string;
  };
  supportHistory: {
    ticketCount: number;
    openCount: number;
    threads: Array<{
      id: string;
      status: string;
      category: string;
      referenceNumber: string | null;
      ticketStatus: string | null;
      priority: string | null;
      createdAt: string;
    }>;
  };
}
