/**
 * Dispute Reconciliation - Core Logic
 *
 * Reconciles dispute status with payment gateways to ensure data consistency.
 * Handles cases where:
 * - DB update failed after Stripe API call succeeded
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
  /** #1459 — Stripe disputes left untouched because the gateway fence is shut. */
  skippedFenced: number;
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
      gstTcsCollectedPaise: number | null;
    } | null;
  },
  gatewayPaymentId: string | null,
): Promise<{
  id: string;
  amount: number;
  gstTcsCollectedPaise: number | null;
} | null> {
  const linked = dispute.payment;
  if (
    linked &&
    linked.gatewayPaymentId &&
    linked.gatewayPaymentId === gatewayPaymentId
  ) {
    return {
      id: linked.id,
      amount: linked.amount,
      gstTcsCollectedPaise: linked.gstTcsCollectedPaise ?? null,
    };
  }
  if (gatewayPaymentId) {
    const byGatewayId = await prisma.payment.findFirst({
      where: { gatewayPaymentId },
      select: { id: true, amount: true, gstTcsCollectedPaise: true },
    });
    if (byGatewayId) {
      return {
        id: byGatewayId.id,
        amount: byGatewayId.amount,
        gstTcsCollectedPaise: byGatewayId.gstTcsCollectedPaise ?? null,
      };
    }
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
          select: { id: true, amount: true, gstTcsCollectedPaise: true },
        });
        if (byOrder) {
          return {
            id: byOrder.id,
            amount: byOrder.amount,
            gstTcsCollectedPaise: byOrder.gstTcsCollectedPaise ?? null,
          };
        }
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
 * payment). Mirrors the Stripe resource_missing note shape.
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
  let skippedFenced = 0;
  // #1351 — Stripe is a contingency rail that is off in production, so the
  // client has no usable credentials. Read once: the fence cannot change
  // mid-run, and a per-dispute read would suggest it could.
  const stripeEnabled = process.env.STRIPE_ENABLED === "true";

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
    payment: {
      id: string;
      amount: number;
      gstTcsCollectedPaise: number | null;
    },
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
              payment: {
                amount: payment.amount,
                gstTcsCollectedPaise: payment.gstTcsCollectedPaise,
              },
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

      const isRazorpay = dispute.paymentGateway === PaymentGateway.RAZORPAY;

      // Razorpay polls via GET /v1/disputes/:id regardless of STRIPE_ENABLED;
      // the Stripe fence below is untouched and stays ordered after this branch.
      let gatewayDispute: {
        status: string;
        evidence?: Record<string, unknown>;
        isChargeRefundable: boolean;
        dueBy?: Date;
      };
      let settlementPayment: {
        id: string;
        amount: number;
        gstTcsCollectedPaise: number | null;
      } | null = null;

      if (isRazorpay) {
        const fetched = (await getDispute(
          dispute.disputeId,
          PaymentGateway.RAZORPAY,
        )) as RazorpayDisputeResult;
        const resolved = await resolveRazorpayDisputePayment(
          dispute,
          fetched.paymentId,
        );
        if (!resolved) {
          await flagDisputeForManualReview(
            dispute,
            `Razorpay dispute ${dispute.disputeId} could not be linked to a payment (gateway payment ${fetched.paymentId ?? "unknown"}) — flagged for manual review (status unchanged)`,
          );
          razorpayManualReviewCount++;
          continue;
        }
        gatewayDispute = fetched;
        settlementPayment = resolved;
      } else {
        // Skip non-Stripe gateways
        if (dispute.paymentGateway !== PaymentGateway.STRIPE) {
          console.log(
            `⏭️ Skipping dispute ${dispute.disputeId} - unsupported gateway: ${dispute.paymentGateway}`,
          );
          continue;
        }

        // #1459 — with the fence shut every getDispute call throws, so the run
        // reported success:false and the sweep looked broken when it was simply
        // asked to reconcile a gateway we deliberately turned off. Count the skip
        // instead: these disputes are still visible to an operator in the result.
        if (!stripeEnabled) {
          skippedFenced++;
          console.log(
            `⏭️ Skipping Stripe dispute ${dispute.disputeId} — STRIPE_ENABLED is not "true"`,
          );
          continue;
        }

        // Query Stripe for current dispute status
        const fetched = await getDispute(
          dispute.disputeId,
          PaymentGateway.STRIPE,
        );
        gatewayDispute = fetched;
        settlementPayment = dispute.payment
          ? {
              id: dispute.payment.id,
              amount: dispute.payment.amount,
              gstTcsCollectedPaise:
                dispute.payment.gstTcsCollectedPaise ?? null,
            }
          : null;
      }

      // Check if status has changed
      // #1584 P1-CR03 — CAS on the status this loop read: a `dispute.lost`
      // webhook landing between fetch and write must not be overwritten by
      // the stale gateway snapshot. A miss is skipped; the next tick re-reads.
      const casWhere = { disputeId: dispute.disputeId, status: dispute.status };
      // Canonical mapping for both gateways: Razorpay `open` lands on
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
        if (isRazorpay) razorpayManualReviewCount++;
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
          if (settlementPayment) {
            await settleAdoptedLoss(
              dispute.id,
              dispute.disputeId,
              dispute.amountPaise,
              settlementPayment,
            );
          } else {
            errors.push(
              `Dispute ${dispute.disputeId}: adopted ${newStatus} with no linked payment — earnings not settled`,
            );
          }
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

      // Razorpay failures never crash the loop: an unknown gateway id is
      // terminal for the row (note for manual review, like the Stripe
      // resource_missing path below), anything else counts toward manual
      // review and is also reported.
      if (dispute.paymentGateway === PaymentGateway.RAZORPAY) {
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
        continue;
      }

      // Also check error code as fallback for StripeError
      const errorCode = (error as { code?: string })?.code;

      // Handle "dispute not found" case - check both error code and message patterns.
      // FIX #566: Do NOT mark as WON — a missing dispute could be a transient
      // API error, a Stripe-side delay, or a dispute that was resolved outside
      // our system. Log it for manual review instead.
      if (
        errorCode === "resource_missing" ||
        errorMessage.includes("resource_missing") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("No such") ||
        errorMessage.includes("does not exist")
      ) {
        const existingEvidence = (dispute.evidence ?? {}) as Record<
          string,
          unknown
        >;
        await prisma.dispute.updateMany({
          where: { disputeId: dispute.disputeId, status: dispute.status },
          data: {
            evidence: {
              ...existingEvidence,
              reconciliation_note:
                "Dispute not found at gateway — flagged for manual review (not auto-resolved)",
              reconciled_at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        console.warn(
          `⚠️ Dispute ${dispute.disputeId} not found at gateway — flagged for manual review (status unchanged)`,
        );
      } else {
        errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
        console.error(
          `Error reconciling dispute ${dispute.disputeId}:`,
          errorMessage,
        );
      }
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: disputesToReconcile.length,
    reconciledCount,
    urgentCount,
    razorpayManualReviewCount,
    skippedFenced,
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
