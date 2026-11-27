/**
 * Dispute Reconciliation - Core Logic
 *
 * Reconciles dispute status with payment gateways to ensure data consistency.
 * Handles cases where:
 * - DB update failed after a gateway call succeeded
 * - Webhooks were missed or delayed
 * - Dispute status changed but webhook wasn't received
 *
 * This module exports the core reconciliation function, driven by the
 * `/api/cleanup/reconcile-disputes` twin on the Netlify ticker. Its last pass
 * discovers gateway disputes the database holds no row for, or holds in
 * another status.
 */

import prisma from "../../lib/prisma";
import { DisputeStatus, PaymentGateway, Prisma } from "@prisma/client";
import {
  getRazorpayDispute,
  isRazorpayUnknownDisputeIdError,
} from "../../lib/payments/core/razorpay-disputes";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "../../lib/payments/core/razorpay";
import { mapDisputeStatus } from "@/lib/payments/dispute-status";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import {
  discoverGatewayDisputes,
  type DisputeDiscoveryRun,
} from "@/lib/payments/discovery/dispute-discovery";

// Prioritize disputes with approaching deadlines (7 days)
const APPROACHING_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

// Flag disputes not updated in 24 hours as potentially stale
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Statuses whose adoption moves money (settleDisputeVerdict). */
const VERDICT_STATUSES = new Set<DisputeStatus>([
  DisputeStatus.WON,
  DisputeStatus.LOST,
  DisputeStatus.CHARGE_REFUNDED,
  DisputeStatus.CLOSED,
  DisputeStatus.WARNING_CLOSED,
]);

export interface DisputeReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  urgentCount: number;
  razorpayManualReviewCount: number;
  /** The discovery pass's counts and the bound that cut it; null when the pass itself threw. */
  discovery: Omit<DisputeDiscoveryRun, "errors" | "checkpoint"> | null;
  /** The discovery position, kept on the run row for the next run; absent when the pass did not run. */
  checkpoint?: string;
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

/** Open Razorpay disputes; both cohorts below narrow it. */
const OPEN_RAZORPAY_DISPUTE_WHERE = {
  paymentGateway: PaymentGateway.RAZORPAY,
  status: {
    in: [
      DisputeStatus.NEEDS_RESPONSE,
      DisputeStatus.WARNING_NEEDS_RESPONSE,
      DisputeStatus.UNDER_REVIEW,
      DisputeStatus.WARNING_UNDER_REVIEW,
    ],
  },
} satisfies Prisma.DisputeWhereInput;

function nearDeadlineDisputeWhere(
  approachingDeadline: Date,
): Prisma.DisputeWhereInput {
  return {
    ...OPEN_RAZORPAY_DISPUTE_WHERE,
    dueBy: { lte: approachingDeadline },
  };
}

function staleDisputeWhere(
  staleThreshold: Date,
  approachingDeadline: Date,
): Prisma.DisputeWhereInput {
  return {
    ...OPEN_RAZORPAY_DISPUTE_WHERE,
    updatedAt: { lt: staleThreshold },
    OR: [{ dueBy: null }, { dueBy: { gt: approachingDeadline } }],
  };
}

/**
 * Find and reconcile disputes that may have stale status
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcileDisputes(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<DisputeReconciliationResult> {
  return withCronLock(
    "reconcile-disputes",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileDisputesUnlocked(opts),
  );
}

async function reconcileDisputesUnlocked(opts: {
  limit?: number;
  startedAt?: number;
}): Promise<DisputeReconciliationResult> {
  const pastDeadline = startDeadline(opts.startedAt ?? Date.now());
  const approachingDeadline = new Date(Date.now() + APPROACHING_DEADLINE_MS);
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const urgentThreshold = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const errors: string[] = [];
  let reconciledCount = 0;
  let urgentCount = 0;
  let razorpayManualReviewCount = 0;

  // Every pass writes the row (or another writer moved it), so ordering by
  // updatedAt rotates a limited run.
  const query = {
    include: { payment: true },
    orderBy: [{ updatedAt: "asc" }, { dueBy: "asc" }],
  } satisfies Omit<Prisma.DisputeFindManyArgs, "where">;
  // A bounded run reserves a third for the stale cohort, since UNDER_REVIEW rows keep
  // a past dueBy for weeks; whichever cohort is short hands its share to the other.
  const limit = opts.limit;
  const staleReserve =
    limit !== undefined && limit >= 2 ? Math.ceil(limit / 3) : 0;
  const deadlineRows = await prisma.dispute.findMany({
    ...query,
    where: nearDeadlineDisputeWhere(approachingDeadline),
    ...(limit === undefined ? {} : { take: limit }),
  });
  const room =
    limit === undefined
      ? undefined
      : limit - Math.min(deadlineRows.length, limit - staleReserve);
  const stale =
    room === 0
      ? []
      : await prisma.dispute.findMany({
          ...query,
          where: staleDisputeWhere(staleThreshold, approachingDeadline),
          ...(room === undefined ? {} : { take: room }),
        });
  const nearDeadline =
    limit === undefined
      ? deadlineRows
      : deadlineRows.slice(0, limit - stale.length);
  const disputesToReconcile = [...nearDeadline, ...stale];

  console.log(`Found ${disputesToReconcile.length} disputes to reconcile`);

  // Adopt a gateway status and settle its verdict in ONE transaction, through
  // the webhook's settlement, so a failed settlement rolls the adoption back
  // for the next tick and a later webhook replay finds nothing left to do.
  async function adoptDisputeStatus(
    dispute: (typeof disputesToReconcile)[number],
    newStatus: DisputeStatus,
    gatewayDispute: Awaited<ReturnType<typeof getRazorpayDispute>>,
    payment: { id: string; amount: number },
  ): Promise<boolean> {
    const verdicts = VERDICT_STATUSES.has(newStatus)
      ? await import("@/app/api/webhooks/utils")
      : null;
    const outcome = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const { count } = await tx.dispute.updateMany({
            where: { disputeId: dispute.disputeId, status: dispute.status },
            data: {
              status: newStatus,
              evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
              isChargeRefundable: gatewayDispute.isChargeRefundable,
              dueBy: gatewayDispute.dueBy,
            },
          });
          if (count === 0) return null;
          return verdicts
            ? verdicts.settleDisputeVerdict(
                tx,
                {
                  id: dispute.id,
                  disputeId: dispute.disputeId,
                  amountPaise: dispute.amountPaise,
                  paymentId: payment.id,
                  payment: { amount: payment.amount },
                },
                newStatus,
                gatewayDispute.amountDeductedPaise,
              )
            : { consultantClawbackPage: null, deductionMismatch: null };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
    if (!outcome) return false;
    if (outcome.deductionMismatch && verdicts) {
      await verdicts.recordDeductionMismatch(outcome.deductionMismatch);
    }
    const page = outcome.consultantClawbackPage;
    if (page) {
      void recordSystemErrorSafe({
        organizationId: null,
        category: "PAYOUT",
        summary: `Chargeback clawback needed: ${page.earnings} PAID consultant earning(s) totalling ${page.amountPaise} paise on dispute ${page.disputeId} (adopted by reconcile-disputes)`,
        err: new Error("CONSULTANT_PAID_EARNING_CLAWBACK"),
        context: { ...page },
      });
    }
    return true;
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

      const gatewayDispute = await getRazorpayDispute(dispute.disputeId);
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
        const adopted = await adoptDisputeStatus(
          dispute,
          newStatus,
          gatewayDispute,
          settlementPayment,
        );
        if (!adopted) {
          console.log(
            `⏭️ Dispute ${dispute.disputeId} moved off ${dispute.status} mid-run — left alone`,
          );
          continue;
        }

        console.log(
          `✅ Reconciled dispute ${dispute.disputeId}: ${dispute.status} -> ${newStatus}`,
        );
        reconciledCount++;
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
      // Touch the row so a dispute that keeps failing rotates behind the rest of the batch.
      await prisma.dispute
        .updateMany({
          where: { disputeId: dispute.disputeId, status: dispute.status },
          data: { updatedAt: new Date() },
        })
        .catch(() => undefined);
      razorpayManualReviewCount++;
      errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
      console.error(
        `Error reconciling Razorpay dispute ${dispute.disputeId}:`,
        errorMessage,
      );
    }
  }

  let discovery: DisputeReconciliationResult["discovery"] = null;
  let checkpoint: string | undefined;
  try {
    const {
      errors: discoveryErrors,
      checkpoint: position,
      ...counts
    } = await discoverGatewayDisputes(pastDeadline);
    discovery = counts;
    checkpoint = position;
    errors.push(...discoveryErrors);
  } catch (error) {
    errors.push(
      `Dispute discovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    success: errors.length === 0,
    totalProcessed: disputesToReconcile.length,
    reconciledCount,
    urgentCount,
    razorpayManualReviewCount,
    discovery,
    ...(checkpoint === undefined ? {} : { checkpoint }),
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
