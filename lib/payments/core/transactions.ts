import { PrismaClient, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

/**
 * Prisma transaction helpers for payment operations
 * Ensures data consistency across payment, refund, and dispute operations
 */

// ============================================================================
// Transaction Types
// ============================================================================

export type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PaymentTransactionCallback<T> = (
  tx: TransactionClient,
) => Promise<T>;

// ============================================================================
// Transaction Wrapper
// ============================================================================

/**
 * Execute a function within a Prisma transaction
 * Automatically handles rollback on errors
 */
export async function withPaymentTransaction<T>(
  callback: PaymentTransactionCallback<T>,
  options?: {
    maxWait?: number; // Max time to wait for transaction slot (ms)
    timeout?: number; // Max time for transaction to complete (ms)
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  return prisma.$transaction(callback, {
    maxWait: options?.maxWait ?? 5000, // 5 seconds default
    timeout: options?.timeout ?? 30000, // 30 seconds default
    isolationLevel: options?.isolationLevel ?? "Serializable",
  });
}

// ============================================================================
// Payment Operation Helpers
// ============================================================================

/**
 * Create a payment record within a transaction
 */
export async function createPaymentRecord(
  tx: TransactionClient,
  data: Prisma.PaymentCreateInput,
) {
  return tx.payment.create({
    data,
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
      appointment: {
        select: {
          id: true,
          appointmentType: true,
        },
      },
    },
  });
}

/**
 * Update a payment status within a transaction
 */
export async function updatePaymentStatus(
  tx: TransactionClient,
  paymentId: string,
  status: "PENDING" | "SUCCEEDED" | "FAILED",
  receiptUrl?: string,
) {
  return tx.payment.update({
    where: { id: paymentId },
    data: {
      paymentStatus: status,
      ...(receiptUrl && { receiptUrl }),
      updatedAt: new Date(),
    },
  });
}

/**
 * Get payment by payment intent ID
 */
export async function getPaymentByIntent(
  tx: TransactionClient,
  paymentIntent: string,
) {
  return tx.payment.findUnique({
    where: { paymentIntent },
    include: {
      user: true,
      appointment: {
        include: {
          consultation: true,
          subscription: true,
          webinar: true,
          class: true,
        },
      },
      refunds: true,
      disputes: true,
    },
  });
}

// ============================================================================
// Refund Operation Helpers
// ============================================================================

/**
 * Create a refund record within a transaction
 */
export async function createRefundRecord(
  tx: TransactionClient,
  data: Prisma.RefundCreateInput,
) {
  return tx.refund.create({
    data,
    include: {
      payment: {
        include: {
          user: true,
          appointment: true,
        },
      },
    },
  });
}

/**
 * Update refund status within a transaction
 */
export async function updateRefundStatus(
  tx: TransactionClient,
  refundId: string,
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED",
) {
  return tx.refund.update({
    where: { refundId },
    data: {
      status,
      updatedAt: new Date(),
    },
  });
}

/**
 * Get refund by refund ID
 */
export async function getRefundByRefundId(
  tx: TransactionClient,
  refundId: string,
) {
  return tx.refund.findUnique({
    where: { refundId },
    include: {
      payment: {
        include: {
          user: true,
          appointment: true,
        },
      },
    },
  });
}

// ============================================================================
// Dispute Operation Helpers
// ============================================================================

/**
 * Create a dispute record within a transaction
 */
export async function createDisputeRecord(
  tx: TransactionClient,
  data: Prisma.DisputeCreateInput,
) {
  return tx.dispute.create({
    data,
    include: {
      payment: {
        include: {
          user: true,
          appointment: true,
        },
      },
    },
  });
}

/**
 * Update dispute status and evidence within a transaction
 */
export async function updateDisputeStatus(
  tx: TransactionClient,
  disputeId: string,
  status:
    | "WARNING_NEEDS_RESPONSE"
    | "WARNING_UNDER_REVIEW"
    | "WARNING_CLOSED"
    | "NEEDS_RESPONSE"
    | "UNDER_REVIEW"
    | "CHARGE_REFUNDED"
    | "WON"
    | "LOST",
  evidence?: Prisma.InputJsonValue,
) {
  return tx.dispute.update({
    where: { disputeId },
    data: {
      status,
      ...(evidence && { evidence }),
      updatedAt: new Date(),
    },
  });
}

/**
 * Get dispute by dispute ID
 */
export async function getDisputeByDisputeId(
  tx: TransactionClient,
  disputeId: string,
) {
  return tx.dispute.findUnique({
    where: { disputeId },
    include: {
      payment: {
        include: {
          user: true,
          appointment: true,
        },
      },
    },
  });
}

// ============================================================================
// Cleanup Helpers
// ============================================================================

/**
 * Delete expired pending payments within a transaction
 */
export async function deleteExpiredPayments(
  tx: TransactionClient,
  beforeDate: Date,
) {
  return tx.payment.deleteMany({
    where: {
      paymentStatus: "PENDING",
      expiresAt: {
        lte: beforeDate,
      },
    },
  });
}

/**
 * Cancel payment intent and mark as failed
 */
export async function cancelAndMarkPaymentFailed(
  tx: TransactionClient,
  paymentId: string,
  reason: string,
) {
  return tx.payment.update({
    where: { id: paymentId },
    data: {
      paymentStatus: "FAILED",
      description: reason,
      updatedAt: new Date(),
    },
  });
}
