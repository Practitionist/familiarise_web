/**
 * Dispute Reconciliation - Core Logic
 *
 * Reconciles dispute status with payment gateways to ensure data consistency.
 * Handles cases where:
 * - DB update failed after a gateway call succeeded
 * - Webhooks were missed or delayed
 * - Dispute status changed but webhook wasn't received
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-disputes.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-disputes/route.ts (API endpoint)
 */

import prisma from "../../lib/prisma";
import { DisputeStatus, PaymentGateway, Prisma } from "@prisma/client";
import { getDispute } from "../../lib/payments";
import {
  isRazorpayUnknownDisputeIdError,
  type RazorpayDisputeResult,
} from "../../lib/payments/core/razorpay-disputes";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "../../lib/payments/core/razorpay";
import { mapDisputeStatus } from "@/lib/payments/dispute-status";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

// Prioritize disputes with approaching deadlines (7 days)
const APPROACHING_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

// Flag disputes not updated in 24 hours as potentially stale
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface DisputeReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  urgentCount: number;
  razorpayManualReviewCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Resolve the payment a polled Razorpay dispute settles against. Prefers the
 * linked row when its gateway id matches, then a gatewayPaymentId lookup,
 * then the order fallback (gateway payment → order_id → paymentIntent). All
 * reads; a miss means manual review, never a guess.
 */
async function resolveRazorpayDisputePayment(
  dispute: {
    disputeId: string;
    payment: {
      id: string;
      amount: number;
      gatewayPaymentId: string | null;
    } | null;
  },
  gatewayPaymentId: string | null,
): Promise<{ id: string; amount: number } | null> {
  const linked = dispute.payment;
  if (
    linked &&
    linked.gatewayPaymentId &&
    linked.gatewayPaymentId === gatewayPaymentId
  ) {
    return { id: linked.id, amount: linked.amount };
  }
  if (gatewayPaymentId) {
    const byGatewayId = await prisma.payment.findFirst({
      where: { gatewayPaymentId },
      select: { id: true, amount: true },
    });
    if (byGatewayId) return byGatewayId;
    try {
      const client = getRazorpayClient();
      const gatewayPayment = client
        ? await withRazorpaySdkTimeout("payments.fetch", () =>
            client.payments.fetch(gatewayPaymentId),
          )
        : null;
      const orderId = gatewayPayment?.order_id;
      if (orderId) {
        const byOrder = await prisma.payment.findFirst({
          where: { paymentIntent: orderId },
          select: { id: true, amount: true },
        });
        if (byOrder) return byOrder;
      }
    } catch (joinError) {
      console.error(
        `Failed to fetch Razorpay payment ${gatewayPaymentId} to link dispute ${dispute.disputeId}:`,
        joinError,
      );
    }
  }
  return null;
}

/**
 * Stamp a dispute for manual review without moving its status — the poll saw
 * something it cannot adopt (unknown gateway id, unmapped status, unlinked
 * payment).
 */
async function flagDisputeForManualReview(
  dispute: { disputeId: string; status: DisputeStatus; evidence: unknown },
  note: string,
): Promise<void> {
  const existingEvidence = (dispute.evidence ?? {}) as Record<string, unknown>;
  await prisma.dispute.updateMany({
    where: { disputeId: dispute.disputeId, status: dispute.status },
    data: {
      evidence: {
        ...existingEvidence,
        reconciliation_note: note,
        reconciled_at: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  console.warn(`⚠️ Dispute ${dispute.disputeId}: ${note}`);
}

/**
 * Find and reconcile disputes that may have stale status
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcileDisputes(): Promise<DisputeReconciliationResult> {
  return withCronLock(
    "reconcile-disputes",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileDisputesUnlocked(),
  );
}

async function reconcileDisputesUnlocked(): Promise<DisputeReconciliationResult> {
  const approachingDeadline = new Date(Date.now() + APPROACHING_DEADLINE_MS);
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const urgentThreshold = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const errors: string[] = [];
  let reconciledCount = 0;
  let urgentCount = 0;
  let razorpayManualReviewCount = 0;

  // Find disputes needing reconciliation
  const disputesToReconcile = await prisma.dispute.findMany({
    where: {
      status: {
        in: [
          DisputeStatus.NEEDS_RESPONSE,
          DisputeStatus.WARNING_NEEDS_RESPONSE,
          DisputeStatus.UNDER_REVIEW,
          DisputeStatus.WARNING_UNDER_REVIEW,
        ],
      },
      OR: [
        { dueBy: { lte: approachingDeadline } },
        { updatedAt: { lt: staleThreshold } },
      ],
    },
    include: {
      payment: true,
    },
    orderBy: {
      dueBy: "asc",
    },
  });

  console.log(`Found ${disputesToReconcile.length} disputes to reconcile`);

  // Settle a freshly adopted LOST/CHARGE_REFUNDED through the webhook's money
  // path. The webhook graph stays out of this job's load path — the shared
  // helper is imported lazily and only on a CAS win. A settlement failure is
  // reported, never thrown: the status adoption above already committed.
  async function settleAdoptedLoss(
    rowId: string,
    disputeId: string,
    amountPaise: number,
    payment: { id: string; amount: number },
  ): Promise<void> {
    try {
      const { settleLostDispute } = await import("@/app/api/webhooks/utils");
      const settled = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) =>
            settleLostDispute(tx, {
              id: rowId,
              disputeId,
              amountPaise,
              paymentId: payment.id,
              payment: { amount: payment.amount },
            }),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      const page = settled.consultantClawbackPage;
      if (page) {
        void recordSystemErrorSafe({
          organizationId: null,
          category: "PAYOUT",
          summary: `Chargeback clawback needed: ${page.earnings} PAID consultant earning(s) totalling ${page.amountPaise} paise on dispute ${page.disputeId} (adopted by reconcile-disputes)`,
          err: new Error("CONSULTANT_PAID_EARNING_CLAWBACK"),
          context: { ...page },
        });
      }
      console.log(`💸 Settled lost dispute ${disputeId} adopted by poll`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `Dispute ${disputeId}: settlement failed after adopting LOST: ${message}`,
      );
      console.error(`Error settling dispute ${disputeId}:`, message);
    }
  }

  for (const dispute of disputesToReconcile) {
    try {
      // Check if dispute is urgent
      if (
        dispute.dueBy &&
        dispute.dueBy.getTime() < urgentThreshold.getTime()
      ) {
        urgentCount++;
        console.warn(
          `⚠️ URGENT: Dispute ${dispute.disputeId} due by ${dispute.dueBy.toISOString()}`,
        );
      }

      if (dispute.paymentGateway !== PaymentGateway.RAZORPAY) {
        console.log(
          `⏭️ Skipping dispute ${dispute.disputeId} - unsupported gateway: ${dispute.paymentGateway}`,
        );
        continue;
      }

      const gatewayDispute = (await getDispute(
        dispute.disputeId,
        PaymentGateway.RAZORPAY,
      )) as RazorpayDisputeResult;
      const settlementPayment = await resolveRazorpayDisputePayment(
        dispute,
        gatewayDispute.paymentId,
      );
      if (!settlementPayment) {
        await flagDisputeForManualReview(
          dispute,
          `Razorpay dispute ${dispute.disputeId} could not be linked to a payment (gateway payment ${gatewayDispute.paymentId ?? "unknown"}) — flagged for manual review (status unchanged)`,
        );
        razorpayManualReviewCount++;
        continue;
      }

      // Check if status has changed
      // #1584 P1-CR03 — CAS on the status this loop read: a `dispute.lost`
      // webhook landing between fetch and write must not be overwritten by
      // the stale gateway snapshot. A miss is skipped; the next tick re-reads.
      const casWhere = { disputeId: dispute.disputeId, status: dispute.status };
      // Canonical mapping: Razorpay `open` lands on
      // NEEDS_RESPONSE and `closed` on CLOSED; an unmapped status answers
      // null and is flagged for manual review, never coerced into a live
      // state.
      const newStatus = mapDisputeStatus(gatewayDispute.status);
      if (newStatus === null) {
        console.warn(
          `Unknown dispute status "${gatewayDispute.status}" for ${dispute.disputeId} — flagged for manual review`,
        );
        await flagDisputeForManualReview(
          dispute,
          `Unknown gateway dispute status "${gatewayDispute.status}" — flagged for manual review (status unchanged)`,
        );
        razorpayManualReviewCount++;
        continue;
      }
      if (newStatus !== dispute.status) {
        const { count } = await prisma.dispute.updateMany({
          where: casWhere,
          data: {
            status: newStatus,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
            dueBy: gatewayDispute.dueBy,
          },
        });
        if (count === 0) {
          console.log(
            `⏭️ Dispute ${dispute.disputeId} moved off ${dispute.status} mid-run — left alone`,
          );
          continue;
        }

        console.log(
          `✅ Reconciled dispute ${dispute.disputeId}: ${dispute.status} -> ${newStatus}`,
        );
        reconciledCount++;

        // Adopting a LOST moves no money by itself — settle through the same
        // path as the webhook, on the CAS win only, so a poll/webhook race
        // still converges on one settlement.
        if (
          newStatus === DisputeStatus.LOST ||
          newStatus === DisputeStatus.CHARGE_REFUNDED
        ) {
          await settleAdoptedLoss(
            dispute.id,
            dispute.disputeId,
            dispute.amountPaise,
            settlementPayment,
          );
        }
      } else {
        // Update dueBy and evidence even if status unchanged
        await prisma.dispute.updateMany({
          where: casWhere,
          data: {
            dueBy: gatewayDispute.dueBy,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
          },
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Failures never crash the loop: an unknown gateway id is terminal for
      // the row (note for manual review); anything else is also reported.
      if (isRazorpayUnknownDisputeIdError(error)) {
        await flagDisputeForManualReview(
          dispute,
          `Dispute ${dispute.disputeId} unknown at Razorpay — flagged for manual review (status unchanged)`,
        );
        razorpayManualReviewCount++;
        continue;
      }
      razorpayManualReviewCount++;
      errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
      console.error(
        `Error reconciling Razorpay dispute ${dispute.disputeId}:`,
        errorMessage,
      );
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: disputesToReconcile.length,
    reconciledCount,
    urgentCount,
    razorpayManualReviewCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
