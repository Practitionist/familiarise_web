/**
 * Refund Reconciliation - Core Logic
 *
 * Reconciles PENDING refunds that may be stuck due to:
 * - App crash after gateway call succeeded but before DB update
 * - Network timeout during Phase 3 of two-phase refund pattern
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-pending-refunds.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-refunds/route.ts (API endpoint)
 */

import prisma from "../../lib/prisma";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import { PaymentGateway, Prisma, RefundStatus } from "@prisma/client";
import { getRefund, listRefunds } from "../../lib/payments";
import {
  isRazorpayUnknownOrderError,
  isRazorpayUnknownRefundIdError,
} from "../../lib/payments/core/razorpay";
import type { RefundResult } from "../../lib/payments/core/types";
import { reportSentryMessage } from "../../lib/observability/report";
import {
  notifyRefundFailed,
  notifyRefundProcessed,
} from "../../lib/novu/service";
import { attemptTrigger, type StagedTrigger } from "../../lib/novu/outbox";
import {
  EMAIL_BUDGET_MS,
  MONEY_EMAIL_TYPES,
  sendRefundFailedEmail,
  stageRefundProcessedEmail,
} from "@/lib/email";
import {
  attemptStaged as attemptStagedEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import { notificationScope } from "../../lib/novu/workflows";
import { getAppUrl } from "../../lib/url";
import { goHref } from "@/lib/dashboard/go";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  applyRefundCascade,
  refundMemberOverageSidePayment,
  type ApplyRefundCascadeResult,
} from "../../lib/payments/operations/refund";
import { reverseCreditsForPayment } from "@/lib/referrals/service";

// Threshold: Only reconcile refunds older than 1 hour
const RECONCILIATION_THRESHOLD_MS = 60 * 60 * 1000;

// Fail a placeholder only after this long WITHOUT any trace at the gateway
const PLACEHOLDER_FAIL_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RefundReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  failedCount: number;
  skippedCount: number;
  /**
   * FAMILIARISE_WEB-3V — the subset of `failedCount` whose gateway has no
   * record of the refund id, or of a placeholder's order (unknown id, or a
   * test-mode id read with live keys). Terminal: moved to FAILED, not polled.
   */
  failedUnknownId: number;
  /**
   * #1757 — the subset of `failedCount` retired because no live client exists
   * for the row's gateway (no implementation) and it was over 24 h old.
   */
  failedGatewayDisabled: number;
  /** SUCCEEDED refunds whose cascade the backstop pass re-drove. */
  redrivenCount: number;
  /** Backstop re-drives that failed this run; they rotate and retry up to the cap. */
  redriveFailedCount: number;
  /** Rows that reached the re-drive cap this run and left the cohort for an operator. */
  redriveDeadLettered: number;
  errors: string[];
  timestamp: string;
}

export interface ReconcilePendingRefundsOptions {
  /**
   * #1356 — applied to EACH pass below in full, not split or subtracted
   * between them: it bounds each pass's own query so a single pass fits the
   * ticker's 26s function ceiling, and the unbounded GitHub Actions run is
   * the backstop that drains whatever a bounded tick leaves behind (ADR 27).
   * Undefined keeps today's unbounded scan.
   */
  limit?: number;
}

/**
 * Map gateway refund status to Prisma RefundStatus
 */

/**
 * Find and reconcile stuck PENDING refunds. Two disjoint populations:
 *
 * 1. Placeholders (`pending_<uuid>`) — Phase 2 of the two-phase refund never
 *    reported back. Matched against the gateway EXACTLY by the reservation id
 *    we ride in the refund notes (#676 B1); a legacy row without gateway-side
 *    reservation notes may fall back to a single unambiguous amount match.
 *    A placeholder is FAILED only when the gateway listing SUCCEEDED and no
 *    refund carrying our reservation id exists after 24h — failing earlier or
 *    on heuristic guesses is what allowed the double-refund chain this cron
 *    was rewritten to close.
 *
 * 2. Real-id PENDING rows — the gateway accepted the refund but settlement
 *    confirmation (`refund.processed`) was lost. Polled by id until the
 *    gateway itself reports processed/failed; never aged out locally, because
 *    normal-speed refunds legitimately take 5–7 business days.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePendingRefunds(
  opts: ReconcilePendingRefundsOptions = {},
): Promise<RefundReconciliationResult> {
  return withCronLock(
    "reconcile-pending-refunds",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcilePendingRefundsUnlocked(opts),
  );
}

async function reconcilePendingRefundsUnlocked(
  opts: ReconcilePendingRefundsOptions = {},
): Promise<RefundReconciliationResult> {
  const thresholdDate = new Date(Date.now() - RECONCILIATION_THRESHOLD_MS);
  const errors: string[] = [];
  let reconciledCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let failedUnknownId = 0;
  let failedGatewayDisabled = 0;
  let totalProcessed = 0;
  const retiredNoClient: string[] = [];
  const failedUnknownOrder: string[] = [];

  /**
   * A row on a gateway with no live client is FAILED/`GATEWAY_DISABLED` past
   * 24 h through the unknown-id CAS (re-opening the refundable balance); younger rows skip.
   */
  const retireIfNoLiveClient = async (refund: {
    id: string;
    refundId: string;
    createdAt: Date;
    payment: { paymentGateway: PaymentGateway };
  }): Promise<boolean> => {
    if (Date.now() - refund.createdAt.getTime() <= PLACEHOLDER_FAIL_AFTER_MS) {
      return false;
    }
    const claim = await prisma.refund.updateMany({
      where: { id: refund.id, status: RefundStatus.PENDING },
      data: {
        status: RefundStatus.FAILED,
        failureReason: "GATEWAY_DISABLED",
        failedAt: new Date(),
      },
    });
    if (claim.count !== 1) return false;
    failedCount++;
    failedGatewayDisabled++;
    retiredNoClient.push(refund.id);
    console.log(
      `❌ Refund ${refund.id} (${refund.refundId}) retired FAILED/GATEWAY_DISABLED - no live ${refund.payment.paymentGateway} client and over 24h old`,
    );
    return true;
  };

  // ------------------------------------------------------------------
  // Pass 1 — placeholders
  // ------------------------------------------------------------------
  const stalePlaceholders = await prisma.refund.findMany({
    where: {
      status: RefundStatus.PENDING,
      refundId: { startsWith: "pending_" },
      createdAt: { lt: thresholdDate },
    },
    include: {
      payment: true,
    },
    // Least-recently-touched first, id tie-break. Neither branch below that
    // leaves a row PENDING (ambiguous / still within grace) writes back to
    // it, so under a bounded run the same cohort can recur every tick; a
    // persisted retry timestamp was deliberately NOT added here (pre-MVP,
    // no-backfill posture) and starvation is capped by the unbounded GitHub
    // Actions run, which always drains the full backlog.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: opts.limit,
  });

  console.log(
    `Found ${stalePlaceholders.length} stale PENDING refund placeholders to reconcile`,
  );
  totalProcessed += stalePlaceholders.length;

  for (const refund of stalePlaceholders) {
    try {
      // Skip if payment gateway is not supported
      if (refund.payment.paymentGateway !== PaymentGateway.RAZORPAY) {
        if (await retireIfNoLiveClient(refund)) continue;
        console.log(
          `⏭️ Skipping refund ${refund.id} - unsupported gateway: ${refund.payment.paymentGateway}`,
        );
        skippedCount++;
        continue;
      }

      // Query gateway for actual refunds on this payment
      const gatewayRefunds = await listRefunds(
        refund.payment.paymentIntent,
        refund.payment.paymentGateway,
        20,
      );

      // Exact bind: we sent `reservationId` in the refund notes/metadata, so
      // the gateway hands it straight back. This is identity, not a guess.
      const exactMatch = gatewayRefunds.find(
        (gr) => gr.metadata?.reservationId === refund.id,
      );

      // Legacy fallback (rows minted before #676 B1 rode the reservation id):
      // bind only when exactly ONE unclaimed-by-reservation gateway refund
      // matches the amount — never guess between multiple candidates.
      const candidates = exactMatch
        ? []
        : gatewayRefunds.filter(
            (gr) =>
              gr.amount === refund.amountPaise &&
              typeof gr.metadata?.reservationId !== "string",
          );
      const fallbackMatch =
        !exactMatch && candidates.length === 1 ? candidates[0] : undefined;

      const matchingRefund = exactMatch ?? fallbackMatch;

      if (matchingRefund) {
        const paymentId = refund.paymentId ?? refund.payment.id;
        const bound = await bindGatewayRefundToPlaceholder(
          refund.id,
          matchingRefund,
          prismaMetadataObject(refund.metadata),
          {
            paymentId,
            amountPaise: refund.amountPaise,
            paymentAmountPaise: refund.payment.amount,
            reason: refund.reason ?? "Gateway refund reconciled",
          },
        );
        if (bound === "bound") {
          console.log(
            `✅ Reconciled refund ${refund.id} -> ${matchingRefund.refundId} (${exactMatch ? "reservation-id" : "unambiguous-amount"} match, status: ${matchingRefund.status})`,
          );
          reconciledCount++;
        } else {
          // Webhook created its own row for the same gateway refund; the
          // placeholder was retired. Settlement proceeds on that row.
          console.log(
            `♻️ Refund ${refund.id} superseded by webhook row for ${matchingRefund.refundId}`,
          );
          reconciledCount++;
        }
        continue;
      }

      // No matching refund found. Ambiguity first: multiple amount-matching
      // candidates without reservation ids must NOT be aged into a failure
      // (a wrong FAIL restores balance and invites a second gateway refund),
      // and must not be guessed between either.
      if (!exactMatch && fallbackMatch === undefined && candidates.length > 1) {
        console.warn(
          `⚠️ Refund ${refund.id}: ${candidates.length} amount-matching gateway refunds without reservation ids; leaving PENDING for manual review`,
        );
        reportSentryMessage(
          `Ambiguous refund reconciliation: ${candidates.length} candidates for placeholder ${refund.id}`,
          { subsystem: "payments", tags: { feature: "refund-reconcile" } },
        );
        skippedCount++;
        continue;
      }

      // The listing above SUCCEEDED, so absence here means the refund
      // genuinely never landed — but only give up after the 24h window.
      const refundAge = Date.now() - refund.createdAt.getTime();
      const isVeryOld = refundAge > PLACEHOLDER_FAIL_AFTER_MS;

      if (isVeryOld) {
        // CAS: a `refund.created` webhook may bind this row to SUCCEEDED
        // between the read and this write — only FAIL a still-PENDING row.
        const claimed = await prisma.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.PENDING },
          data: {
            status: RefundStatus.FAILED,
            metadata: {
              ...(refund.metadata as object),
              reconciliation_error:
                "No refund carrying this reservation id found at gateway after 24 hours",
              reconciled_at: new Date().toISOString(),
            },
          },
        });
        if (claimed.count === 0) {
          skippedCount++;
          continue;
        }

        console.log(
          `❌ Marked refund ${refund.id} as FAILED - no matching gateway refund found`,
        );
        failedCount++;
      } else {
        console.log(
          `⏳ Skipping refund ${refund.id} - no match found but still within grace period`,
        );
        skippedCount++;
      }
    } catch (error) {
      // Order 404: no refund exists under these keys and a retry 404s before
      // money moves, so past 24h FAILED is safe; younger rows wait.
      if (isRazorpayUnknownOrderError(error)) {
        if (
          Date.now() - refund.createdAt.getTime() <=
          PLACEHOLDER_FAIL_AFTER_MS
        ) {
          skippedCount++;
          continue;
        }
        const claim = await prisma.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.PENDING },
          data: {
            status: RefundStatus.FAILED,
            failureReason: `Gateway has no record of order ${refund.payment.paymentIntent} (unknown id, or a test-mode id read with live keys); the customer was not refunded — issue a new refund`,
            failedAt: new Date(),
          },
        });
        if (claim.count === 1) {
          failedCount++;
          failedUnknownId++;
          failedUnknownOrder.push(refund.id);
        } else {
          skippedCount++;
        }
        continue;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Error reconciling refund ${refund.id}:`, errorMessage);
    }
  }

  // ------------------------------------------------------------------
  // Pass 2 — real-id PENDING rows (gateway accepted, confirmation lost)
  // ------------------------------------------------------------------
  const SYNTHETIC_PREFIXES = ["pending_", "internal_", "credits_"];
  const pendingRealId = await prisma.refund.findMany({
    where: {
      status: RefundStatus.PENDING,
      // booking-refund.ts mints internal_<uuid>/credits_<uuid> synthetic ids
      // alongside the pending_ placeholders — none exist at any gateway.
      AND: SYNTHETIC_PREFIXES.map((prefix) => ({
        refundId: { not: { startsWith: prefix } },
      })),
      createdAt: { lt: thresholdDate },
    },
    include: {
      payment: {
        select: {
          id: true,
          amount: true,
          paymentGateway: true,
          userId: true,
          organizationId: true,
        },
      },
    },
    // Same starvation reasoning as the placeholder pass above: "still
    // settling" leaves the row untouched, so order least-recently-touched
    // first rather than by creation.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: opts.limit,
  });

  console.log(`Found ${pendingRealId.length} real-id PENDING refunds to poll`);
  totalProcessed += pendingRealId.length;

  for (const refund of pendingRealId) {
    try {
      if (refund.payment.paymentGateway !== PaymentGateway.RAZORPAY) {
        if (await retireIfNoLiveClient(refund)) continue;
        skippedCount++;
        continue;
      }

      const gatewayRefund = await getRefund(
        refund.refundId,
        refund.payment.paymentGateway,
      );

      if (gatewayRefund.status === RefundStatus.SUCCEEDED) {
        // #1589 N-P0-01 — this mark stands in for the lost `refund.processed`
        // webhook, so it owes the payer the same bell and receipt: staged in
        // the mark's own tx, attempted after it. The outbox's deterministic
        // transactionId (lib/novu/outbox.ts) makes a re-drive safe.
        let bell: StagedTrigger | null = null;
        let emails: StagedRecipientEmail[] = [];
        let overageDue: ApplyRefundCascadeResult["memberOverageRefundDue"] =
          null;
        const claimed = await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              overageDue = null;
              // Claim by status: a re-entrant run or a webhook that settled the
              // row first matches zero rows and stages nothing.
              const claim = await tx.refund.updateMany({
                where: { id: refund.id, status: RefundStatus.PENDING },
                data: { status: RefundStatus.SUCCEEDED, updatedAt: new Date() },
              });
              if (claim.count !== 1) return false;
              const cascade = await applyRefundCascade(tx, {
                paymentId: refund.payment.id,
                refundId: refund.id,
                amountPaise: refund.amountPaise,
                reason: refund.reason ?? "Gateway refund reconciled",
                initiatedByUserId: null,
              });
              overageDue = cascade.memberOverageRefundDue;
              await reverseCreditsForPayment(
                refund.payment.id,
                tx,
                refund.amountPaise,
                refund.payment.amount,
                refund.id,
              );
              const notice = await notifyRefundProcessed(
                refund.payment.userId,
                {
                  ...notificationScope(refund.payment.organizationId),
                  amount: refund.amountPaise,
                  currency: refund.currency,
                  // The payer's money view, matching the other money bells.
                  dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
                },
                { tx, entityRef: `payment:${refund.payment.id}` },
              );
              bell = notice?.staged ?? null;
              emails = await stageRefundProcessedEmail(tx, {
                userId: refund.payment.userId,
                paymentId: refund.payment.id,
                amountPaise: refund.amountPaise,
                currency: refund.currency,
              });
              return true;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        if (!claimed) {
          console.log(
            `♻️ Real-id refund ${refund.id} (${refund.refundId}) was settled by another writer; nothing to mark`,
          );
          skippedCount++;
          continue;
        }
        await refundMemberOverageSidePayment({
          parentPaymentId: refund.payment.id,
          due: overageDue,
          initiatedByUserId: null,
        });
        await attemptRefundNotice(bell, emails);
        console.log(
          `✅ Real-id refund ${refund.id} (${refund.refundId}) confirmed settled at gateway and cascaded`,
        );
        reconciledCount++;
      } else if (gatewayRefund.status === RefundStatus.FAILED) {
        const claimed = await prisma.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.PENDING },
          data: {
            status: RefundStatus.FAILED,
            failureReason: "Gateway reports the refund failed",
            failedAt: new Date(),
          },
        });
        if (claimed.count === 0) {
          skippedCount++;
          continue;
        }
        console.log(
          `❌ Real-id refund ${refund.id} (${refund.refundId}) failed at gateway`,
        );
        failedCount++;
      } else {
        // Still settling at the gateway (normal refunds take 5–7 business
        // days) — the webhook or a later poll completes it. Never age out.
        skippedCount++;
      }
    } catch (error) {
      if (isRazorpayUnknownRefundIdError(error)) {
        // FAMILIARISE_WEB-3V — terminal, not transient; same FAILED shape as
        // above, CAS on PENDING so a webhook that settled it is not undone.
        const claim = await prisma.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.PENDING },
          data: {
            status: RefundStatus.FAILED,
            failureReason: `Gateway has no record of refund id ${refund.refundId} (unknown id, or a test-mode id read with live keys); the customer was not refunded — issue a new refund`,
            failedAt: new Date(),
          },
        });
        if (claim.count === 1) {
          failedCount++;
          failedUnknownId++;
          reportSentryMessage(
            `Refund ${refund.id} moved to FAILED: gateway has no record of ${refund.refundId}`,
            {
              subsystem: "payments",
              op: "refund-reconcile.unknown-id",
              expected: true,
              level: "warning",
              tags: { provider: "razorpay" },
              extra: { refundRowId: refund.id, refundId: refund.refundId },
            },
          );
        }
        console.error(
          `❌ Real-id refund ${refund.id} (${refund.refundId}) unknown at gateway; marked FAILED`,
        );
        continue;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Error polling refund ${refund.id}:`, errorMessage);
    }
  }

  // A poison row is a per-row failure in the summary, never a failed run.
  const backstop = await redriveStrandedRefunds(opts.limit);
  totalProcessed += backstop.scanned;

  // One expected warning per run listing the ids, never one per row per tick.
  if (retiredNoClient.length > 0) {
    reportSentryMessage(
      `reconcile-pending-refunds: retired ${retiredNoClient.length} PENDING refund(s) with no live gateway client (GATEWAY_DISABLED)`,
      {
        subsystem: "payments",
        op: "refund-reconcile.gateway-disabled",
        expected: true,
        level: "warning",
        extra: { retired: retiredNoClient },
      },
    );
  }

  if (failedUnknownOrder.length > 0) {
    reportSentryMessage(
      `reconcile-pending-refunds: FAILED ${failedUnknownOrder.length} placeholder refund(s) whose order the gateway does not know`,
      {
        subsystem: "payments",
        op: "refund-reconcile.unknown-order",
        expected: true,
        level: "warning",
        tags: { provider: "razorpay" },
        extra: { failed: failedUnknownOrder },
      },
    );
  }

  await notifyFailedRefundsUnlocked();

  return {
    success: errors.length === 0,
    totalProcessed,
    reconciledCount,
    failedCount,
    skippedCount,
    failedUnknownId,
    failedGatewayDisabled,
    redrivenCount: backstop.redriven,
    redriveFailedCount: backstop.failed,
    redriveDeadLettered: backstop.deadLettered.length,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Bind a matched gateway refund onto a placeholder row. P2002-tolerant: the
 * `refund.created` webhook may have already created its own row under the
 * real gateway id — in that case the placeholder (a pure reservation with no
 * cascade effects) is retired so it stops counting against the refundable
 * balance, and settlement continues on the webhook's row.
 *
 * Returns "bound" when the placeholder now carries the gateway id, or
 * "superseded" when the webhook's row won and the placeholder was deleted.
 */
async function bindGatewayRefundToPlaceholder(
  placeholderRowId: string,
  gatewayRefund: RefundResult,
  existingMetadata: Record<string, unknown>,
  cascade: {
    paymentId: string;
    amountPaise: number;
    paymentAmountPaise?: number;
    reason: string;
  },
): Promise<"bound" | "superseded"> {
  const nextStatus = mapGatewayRefundStatus(gatewayRefund.status);
  const mergedMetadata = {
    ...existingMetadata,
    ...(gatewayRefund.metadata ?? {}),
    reconciled_at: new Date().toISOString(),
  } as Prisma.InputJsonValue;

  try {
    const overageDue = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.refund.update({
            where: { id: placeholderRowId },
            data: {
              refundId: gatewayRefund.refundId,
              status: nextStatus,
              metadata: mergedMetadata,
            },
          });
          if (nextStatus !== RefundStatus.SUCCEEDED) return null;
          const result = await applyRefundCascade(tx, {
            paymentId: cascade.paymentId,
            refundId: placeholderRowId,
            amountPaise: cascade.amountPaise,
            reason: cascade.reason,
            initiatedByUserId: null,
          });
          await reverseCreditsForPayment(
            cascade.paymentId,
            tx,
            cascade.amountPaise,
            cascade.paymentAmountPaise,
            placeholderRowId,
          );
          return result.memberOverageRefundDue;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    await refundMemberOverageSidePayment({
      parentPaymentId: cascade.paymentId,
      due: overageDue,
      initiatedByUserId: null,
    });
    return "bound";
  } catch (error) {
    if (
      !(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
    ) {
      throw error;
    }
  }

  const winner = await prisma.refund.findUnique({
    where: { refundId: gatewayRefund.refundId },
    select: { id: true, paymentId: true },
  });
  const placeholder = await prisma.refund.findUnique({
    where: { id: placeholderRowId },
    select: { paymentId: true },
  });
  if (!winner || !placeholder || winner.paymentId !== placeholder.paymentId) {
    // Collision outside the same payment is an integrity fault, not a race.
    throw new Error(
      `Refund id collision across payments while reconciling ${placeholderRowId} -> ${gatewayRefund.refundId}`,
    );
  }
  await prisma.refund.delete({ where: { id: placeholderRowId } });
  return "superseded";
}

/** Post-commit half of the SUCCEEDED-mark notice; a parameter so TS's narrowing cannot see the closure. */
async function attemptRefundNotice(
  bell: StagedTrigger | null,
  emails: StagedRecipientEmail[],
): Promise<void> {
  if (bell) await attemptTrigger(bell);
  await attemptStagedEmails(
    emails,
    MONEY_EMAIL_TYPES.REFUND_PROCESSED,
    EMAIL_BUDGET_MS.JOB,
  );
}

// A SUCCEEDED refund still uncascaded this long after its last write is stranded.
const STRANDED_AFTER_MS = 10 * 60 * 1000;
const STRANDED_BATCH = 10;
/** Stops starting new re-drives once the pass has run this long. */
const STRANDED_BUDGET_MS = 8_000;
/** Failed re-drives after which a row leaves the cohort for an operator (as retry-auto-refunds). */
const MAX_CASCADE_REDRIVE_ATTEMPTS = 3;
/** The metadata key the cohort query below reads by its literal name. */
const REDRIVE_ATTEMPTS_KEY = "cascadeRedriveAttempts";

type StrandedPass = {
  scanned: number;
  redriven: number;
  failed: number;
  deadLettered: string[];
};

/**
 * Backstop pass: re-drives the cascade of SUCCEEDED refunds whose cascade never
 * committed. The cascadedAt claim inside applyRefundCascade keeps it idempotent.
 */
async function redriveStrandedRefunds(
  limit: number | undefined,
): Promise<StrandedPass> {
  const startedAt = Date.now();
  // Raw because a missing JSON key must count as zero attempts; credit
  // restorations (amountPaise 0) settle in place and never cascade.
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Refund"
    WHERE status = 'SUCCEEDED'
      AND "cascadedAt" IS NULL
      AND "deletedAt" IS NULL
      AND "amountPaise" > 0
      AND "updatedAt" < ${new Date(startedAt - STRANDED_AFTER_MS)}
      AND COALESCE(
        CASE jsonb_typeof(metadata -> 'cascadeRedriveAttempts')
          WHEN 'number' THEN (metadata ->> 'cascadeRedriveAttempts')::numeric
        END, 0) < ${MAX_CASCADE_REDRIVE_ATTEMPTS}
    ORDER BY "updatedAt" ASC, id ASC
    LIMIT ${Math.min(limit ?? STRANDED_BATCH, STRANDED_BATCH)}`;
  const pass: StrandedPass = {
    scanned: 0,
    redriven: 0,
    failed: 0,
    deadLettered: [],
  };
  if (due.length === 0) return pass;

  const stranded = await prisma.refund.findMany({
    where: { id: { in: due.map((r) => r.id) } },
    select: {
      id: true,
      paymentId: true,
      amountPaise: true,
      reason: true,
      metadata: true,
      payment: { select: { amount: true } },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });

  for (const refund of stranded) {
    if (Date.now() - startedAt > STRANDED_BUDGET_MS) break;
    pass.scanned++;
    try {
      const cascade = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const result = await applyRefundCascade(tx, {
              paymentId: refund.paymentId,
              refundId: refund.id,
              amountPaise: refund.amountPaise,
              reason: refund.reason ?? "Stranded refund re-driven",
              initiatedByUserId: null,
            });
            await reverseCreditsForPayment(
              refund.paymentId,
              tx,
              refund.amountPaise,
              refund.payment.amount,
              refund.id,
            );
            return result;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      pass.redriven++;
      await refundMemberOverageSidePayment({
        parentPaymentId: refund.paymentId,
        due: cascade.memberOverageRefundDue,
        initiatedByUserId: null,
      });
    } catch (error) {
      pass.failed++;
      console.error(
        `Error re-driving refund ${refund.id}:`,
        error instanceof Error ? error.message : String(error),
      );
      if (await recordRedriveFailure(refund)) {
        pass.deadLettered.push(refund.id);
      }
    }
  }

  if (pass.deadLettered.length > 0) {
    reportSentryMessage(
      `reconcile-pending-refunds: ${pass.deadLettered.length} SUCCEEDED refund(s) dead-lettered after ${MAX_CASCADE_REDRIVE_ATTEMPTS} failed cascade re-drives`,
      {
        subsystem: "payments",
        op: "refund-reconcile.cascade-dead-letter",
        level: "error",
        extra: { refundIds: pass.deadLettered },
      },
    );
  }
  return pass;
}

/**
 * Bumps the attempt counter and updatedAt so a failing row rotates behind the
 * rest of the cohort; returns whether this failure reached the cap.
 */
async function recordRedriveFailure(refund: {
  id: string;
  metadata: Prisma.JsonValue;
}): Promise<boolean> {
  const metadata: Prisma.JsonObject =
    refund.metadata !== null &&
    typeof refund.metadata === "object" &&
    !Array.isArray(refund.metadata)
      ? refund.metadata
      : {};
  const prior = metadata[REDRIVE_ATTEMPTS_KEY];
  const attempts = (typeof prior === "number" ? prior : 0) + 1;
  try {
    const touched = await prisma.refund.updateMany({
      where: {
        id: refund.id,
        status: RefundStatus.SUCCEEDED,
        cascadedAt: null,
      },
      data: {
        metadata: { ...metadata, [REDRIVE_ATTEMPTS_KEY]: attempts },
        updatedAt: new Date(),
      },
    });
    return touched.count === 1 && attempts >= MAX_CASCADE_REDRIVE_ATTEMPTS;
  } catch (error) {
    console.error(
      `Error recording re-drive failure for refund ${refund.id}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function prismaMetadataObject(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

// #779 §A — default failure reason when the gateway metadata carries none.
const REFUND_FAILED_DEFAULT_REASON = "Gateway rejected the refund";

export interface FailedRefundNotifyResult {
  scanned: number;
  notified: number;
}

/**
 * #779 §A — notify the payer when a refund FAILED. The two-phase refund +
 * reconcile path can leave a Refund in FAILED without the payer ever hearing.
 * Selects FAILED refunds where `failedNotifiedAt` is null, backfills
 * `failureReason` / `failedAt` if empty (from gateway metadata if present,
 * else the default copy), notifies the payer, and claim-stamps
 * `failedNotifiedAt` so the same failure isn't paged twice.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function notifyFailedRefunds(): Promise<FailedRefundNotifyResult> {
  return withCronLock(
    "reconcile-pending-refunds",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => notifyFailedRefundsUnlocked(),
  );
}

async function notifyFailedRefundsUnlocked(): Promise<FailedRefundNotifyResult> {
  const now = new Date();
  const failed =
    (await prisma.refund.findMany({
      where: {
        status: RefundStatus.FAILED,
        failedNotifiedAt: null,
      },
      include: { payment: { select: { userId: true, organizationId: true } } },
      orderBy: { createdAt: "asc" },
    })) ?? [];

  let notified = 0;
  for (const refund of failed) {
    // Prefer a gateway-supplied reason carried in metadata; fall back to the
    // existing operator `reason` only as failure context, else default copy.
    const meta = (refund.metadata ?? {}) as Record<string, unknown>;
    const gatewayReason =
      typeof meta.failure_reason === "string"
        ? meta.failure_reason
        : typeof meta.error_description === "string"
          ? meta.error_description
          : null;
    const failureReason =
      refund.failureReason ?? gatewayReason ?? REFUND_FAILED_DEFAULT_REASON;

    // Claim the row: stamp failedNotifiedAt only if still null so a re-run or
    // a second replica can't double-notify. Backfill failureReason / failedAt
    // in the same gate when they're empty.
    const claim = await prisma.refund.updateMany({
      where: { id: refund.id, failedNotifiedAt: null },
      data: {
        failedNotifiedAt: now,
        failureReason: refund.failureReason ?? failureReason,
        failedAt: refund.failedAt ?? now,
      },
    });
    if (claim.count === 0) continue;
    notified++;

    // Fire-and-forget — committed state, no DB writes in the notify path.
    await notifyRefundFailed(refund.payment.userId, {
      ...notificationScope(refund.payment.organizationId),
      amount: refund.amountPaise,
      currency: refund.currency,
      reason: failureReason,
      dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
    });
    // #1653 — the email twin; the sender never throws.
    await sendRefundFailedEmail({
      userId: refund.payment.userId,
      paymentId: refund.paymentId,
      amountPaise: refund.amountPaise,
      currency: refund.currency,
    });
  }

  return { scanned: failed.length, notified };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
