/**
 * Reconciles PENDING refunds whose gateway outcome never reached the database:
 * a crash or timeout between the gateway call and the bind, or a lost webhook.
 * Its last pass discovers gateway refunds the database holds no row for.
 * Registered as `reconcile-refunds` in lib/cron/cleanup-registry.ts.
 */

import {
  refundNoticeKind,
  refundNoticeOverride,
} from "@/lib/payments/operations/refund-cause";
import { startDeadline } from "@/lib/cron/run-deadline";
import {
  compareLeastRecentlyReconciled,
  LEAST_RECENTLY_RECONCILED,
} from "@/lib/payments/payouts/reconcile-cursor";
import prisma from "../../lib/prisma";
import {
  failRefund,
  resettleOwedOnLateSuccess,
} from "@/lib/payments/operations/refund-owed";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import { PaymentGateway, Prisma, RefundStatus } from "@prisma/client";
import { z } from "zod";
import { getRefund, listRefunds } from "../../lib/payments";
import {
  getRazorpayClient,
  isRazorpayUnknownOrderError,
  isRazorpayUnknownRefundIdError,
  withRazorpaySdkTimeout,
} from "../../lib/payments/core/razorpay";
import { razorpayFetchedPaymentSchema } from "@/schemas/webhooks/razorpay";
import type { RefundResult } from "../../lib/payments/core/types";
import { reportSentryMessage } from "../../lib/observability/report";
import { reportStandingFinding } from "../../lib/observability/standing-finding";
import {
  notifyRefundFailed,
  notifyRefundProcessed,
} from "../../lib/novu/service";
import { attemptTrigger, type StagedTrigger } from "../../lib/novu/outbox";
import {
  EMAIL_BUDGET_MS,
  MONEY_EMAIL_TYPES,
  prepareRefundFailedEmail,
  prepareRefundProcessedEmail,
  stageRefundFailedEmail,
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
import { applyRefundCascade } from "../../lib/payments/operations/refund";
import { settleRefundSeatTx } from "../../lib/payments/operations/refund-seat";
import { retireSupersededPlaceholderTx } from "../../lib/payments/operations/refund-placeholder";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import {
  discoverGatewayRefunds,
  type RefundDiscoveryRun,
} from "@/lib/payments/discovery/refund-discovery";

// Threshold: Only reconcile refunds older than 1 hour
const RECONCILIATION_THRESHOLD_MS = 60 * 60 * 1000;

// Fail a placeholder only after this long WITHOUT any trace at the gateway
const PLACEHOLDER_FAIL_AFTER_MS = 24 * 60 * 60 * 1000;

/** The gateway's largest page; a search ends at the first short page or after this many pages. */
const REFUND_LIST_PAGE_SIZE = 100;
const REFUND_LIST_MAX_PAGES = 5;

export interface RefundReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  failedCount: number;
  skippedCount: number;
  /**
   * Rows left PENDING because the gateway did not answer for them under these
   * keys: an unknown-id or 404 answer, a capture these keys cannot read as
   * captured, or a refund listing that ran past the page bound.
   */
  unknownAtGateway: number;
  /**
   * The subset of `failedCount` retired because no live client exists for the
   * row's gateway (no implementation) and it was over 24 h old.
   */
  failedGatewayDisabled: number;
  /** SUCCEEDED refunds whose cascade the backstop pass re-drove. */
  redrivenCount: number;
  /** Backstop re-drives that failed this run; they rotate and retry up to the cap. */
  redriveFailedCount: number;
  /** Rows that reached the re-drive cap this run and left the cohort for an operator. */
  redriveDeadLettered: number;
  /** The discovery pass's counts and the bound that cut it; null when the pass itself threw. */
  discovery: Omit<RefundDiscoveryRun, "errors" | "checkpoint"> | null;
  /** The discovery position, kept on the run row for the next run; absent when the pass did not run. */
  checkpoint?: string;
  errors: string[];
  timestamp: string;
}

const SYNTHETIC_PREFIXES = ["pending_", "internal_", "credits_"];

/** Pass 1 placeholders. */
function placeholderRefundWhere(createdBefore: Date): Prisma.RefundWhereInput {
  return {
    status: RefundStatus.PENDING,
    refundId: { startsWith: "pending_" },
    createdAt: { lt: createdBefore },
  };
}

/** Pass 2 real-id PENDING rows. */
function realIdPendingRefundWhere(
  createdBefore: Date,
): Prisma.RefundWhereInput {
  return {
    status: RefundStatus.PENDING,
    AND: SYNTHETIC_PREFIXES.map((prefix) => ({
      refundId: { not: { startsWith: prefix } },
    })),
    createdAt: { lt: createdBefore },
  };
}

export interface ReconcilePendingRefundsOptions {
  /** Maximum pending refunds examined per run, across both gateway cohorts. */
  limit?: number;
  startedAt?: number;
}

type ReservationSearch = {
  match: RefundResult | null;
  /** Gateway refunds of the reserved amount that carry no reservation id. */
  unclaimedSameAmount: number;
  /** False when the page bound was reached before a short page. */
  complete: boolean;
};

/**
 * Pages through the refunds of the captured gateway payment (the order when
 * the row has no captured id) and returns the one carrying this reservation id.
 */
async function searchReservedRefund(refund: {
  id: string;
  amountPaise: number;
  payment: {
    paymentIntent: string;
    gatewayPaymentId: string | null;
    paymentGateway: PaymentGateway;
  };
}): Promise<ReservationSearch> {
  const target =
    refund.payment.gatewayPaymentId ?? refund.payment.paymentIntent;
  let unclaimedSameAmount = 0;
  for (let page = 0; page < REFUND_LIST_MAX_PAGES; page++) {
    const items = await listRefunds(
      target,
      refund.payment.paymentGateway,
      REFUND_LIST_PAGE_SIZE,
      page * REFUND_LIST_PAGE_SIZE,
    );
    const match = items.find((gr) => gr.metadata?.reservationId === refund.id);
    if (match) return { match, unclaimedSameAmount, complete: false };
    // An absent, empty or blank note names no reservation, so it claims nothing.
    unclaimedSameAmount += items.filter((gr) => {
      const noted = gr.metadata?.reservationId;
      return (
        gr.amount === refund.amountPaise &&
        (typeof noted !== "string" || noted.trim() === "")
      );
    }).length;
    if (items.length < REFUND_LIST_PAGE_SIZE) {
      return { match: null, unclaimedSameAmount, complete: true };
    }
  }
  return { match: null, unclaimedSameAmount, complete: false };
}

const fetchedCaptureSchema = razorpayFetchedPaymentSchema.extend({
  id: z.string(),
});

/**
 * True only when these keys read the row's captured gateway payment as
 * captured; an empty refund listing proves absence only alongside this.
 */
async function gatewayShowsCapture(
  gatewayPaymentId: string | null,
): Promise<boolean> {
  const client = getRazorpayClient();
  if (!client || !gatewayPaymentId) return false;
  try {
    const fetched = fetchedCaptureSchema.safeParse(
      await withRazorpaySdkTimeout("payments.fetch", () =>
        client.payments.fetch(gatewayPaymentId),
      ),
    );
    return (
      fetched.success &&
      fetched.data.id === gatewayPaymentId &&
      fetched.data.status === "captured"
    );
  } catch (error) {
    console.warn(
      `Could not read gateway payment ${gatewayPaymentId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** An unknown-id or 404 answer, which an id of the other key mode also gets. */
function isUnknownAtGateway(error: unknown): boolean {
  return (
    isRazorpayUnknownOrderError(error) || isRazorpayUnknownRefundIdError(error)
  );
}

/**
 * Find and reconcile stuck PENDING refunds. Two disjoint populations:
 *
 * 1. Placeholders (`pending_<uuid>`): the gateway call never reported back.
 *    Bound only to the gateway refund carrying the reservation id we ride in
 *    the refund notes. FAILED only when the row is over 24h old, the complete
 *    listing of the capture's refunds holds no such refund and none of the
 *    same amount without a note, and these keys read the capture as captured.
 *
 * 2. Real-id PENDING rows: the gateway accepted the refund but the settlement
 *    confirmation was lost. Polled by id until the gateway itself reports
 *    processed or failed; never aged out locally, because normal-speed refunds
 *    take 5 to 7 business days.
 *
 * An unknown-id or 404 answer never fails a row: it stays PENDING and the run
 * raises one standing finding.
 */
// Locked at the core so every door shares one mutual exclusion; fail-closed.
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
  const startedAt = opts.startedAt ?? Date.now();
  const pastDeadline = startDeadline(startedAt);
  // Reserve time for settled-cascade recovery and durable failure notices.
  const pendingDeadline = () => Date.now() >= startedAt + 8_000;
  const limit = opts.limit ?? 10;
  const thresholdDate = new Date(Date.now() - RECONCILIATION_THRESHOLD_MS);
  const errors: string[] = [];
  let reconciledCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let failedGatewayDisabled = 0;
  let totalProcessed = 0;
  const retiredNoClient: string[] = [];
  const ambiguousPlaceholders: string[] = [];
  const unknownAtGateway: string[] = [];

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
    const claim = await failRefund(refund.id, (tx) =>
      tx.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.PENDING },
        data: {
          status: RefundStatus.FAILED,
          failureReason: "GATEWAY_DISABLED",
          failedAt: new Date(),
        },
      }),
    );
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
  const placeholders = await prisma.refund.findMany({
    where: placeholderRefundWhere(thresholdDate),
    include: {
      payment: true,
    },
    orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
    take: limit,
  });

  const realIds = await prisma.refund.findMany({
    where: realIdPendingRefundWhere(thresholdDate),
    include: { payment: true },
    orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
    take: limit,
  });
  // Select across both rails before processing either, so a slow rail cannot starve the other.
  const pending = [...placeholders, ...realIds]
    .sort(compareLeastRecentlyReconciled)
    .slice(0, limit);
  const stalePlaceholders = pending.filter((r) =>
    r.refundId.startsWith("pending_"),
  );
  const pendingRealId = pending.filter(
    (r) => !r.refundId.startsWith("pending_"),
  );

  console.log(
    `Found ${stalePlaceholders.length} stale PENDING refund placeholders to reconcile`,
  );

  for (const refund of stalePlaceholders) {
    if (pendingDeadline()) break;
    totalProcessed++;
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

      const search = await searchReservedRefund(refund);
      const matchingRefund = search.match;

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
            userId: refund.payment.userId,
            organizationId: refund.payment.organizationId,
            currency: refund.currency,
          },
        );
        if (bound === "bound") {
          console.log(
            `✅ Reconciled refund ${refund.id} -> ${matchingRefund.refundId} (reservation-id match, status: ${matchingRefund.status})`,
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

      // A same-amount gateway refund without a reservation note may be this
      // one: never adopt it on a guess and never age the row into a failure.
      if (search.unclaimedSameAmount > 0) {
        console.warn(
          `⚠️ Refund ${refund.id}: ${search.unclaimedSameAmount} same-amount gateway refund(s) without a reservation id; leaving PENDING for manual review`,
        );
        ambiguousPlaceholders.push(refund.id);
        skippedCount++;
        continue;
      }

      // Past the page bound the listing is not proof of absence.
      if (!search.complete) {
        unknownAtGateway.push(refund.id);
        skippedCount++;
        continue;
      }

      const refundAge = Date.now() - refund.createdAt.getTime();
      const isVeryOld = refundAge > PLACEHOLDER_FAIL_AFTER_MS;

      // An empty listing counts only when these keys can see the capture.
      if (
        isVeryOld &&
        !(await gatewayShowsCapture(refund.payment.gatewayPaymentId))
      ) {
        unknownAtGateway.push(refund.id);
        skippedCount++;
        continue;
      }

      if (isVeryOld) {
        // Only a row still PENDING under the placeholder id read above is
        // failed: one a webhook or the binder settled or bound meanwhile is not.
        const claimed = await failRefund(refund.id, (tx) =>
          tx.refund.updateMany({
            where: {
              id: refund.id,
              status: RefundStatus.PENDING,
              refundId: refund.refundId,
            },
            data: {
              status: RefundStatus.FAILED,
              metadata: {
                ...(refund.metadata as object),
                reconciliation_error:
                  "No refund carrying this reservation id found at gateway after 24 hours",
                reconciled_at: new Date().toISOString(),
              },
            },
          }),
        );
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
      if (isUnknownAtGateway(error)) {
        unknownAtGateway.push(refund.id);
        skippedCount++;
        continue;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Error reconciling refund ${refund.id}:`, errorMessage);
    } finally {
      try {
        await prisma.$executeRaw`UPDATE "Refund" SET "lastReconciledAt" = now() WHERE id = ${refund.id}`;
      } catch (error) {
        errors.push(
          `Polling cursor Refund ${refund.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  console.log(`Found ${pendingRealId.length} real-id PENDING refunds to poll`);

  for (const refund of pendingRealId) {
    if (pendingDeadline()) break;
    totalProcessed++;
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
        const receiptArgs = {
          userId: refund.payment.userId,
          paymentId: refund.payment.id,
          amountPaise: refund.amountPaise,
          currency: refund.currency,
          required: refundNoticeKind(refund.reason) !== null,
        };
        const receipt = await prepareRefundProcessedEmail(receiptArgs).catch(
          () => null,
        );
        const claimed = await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              // Claim by status: a re-entrant run or a webhook that settled the
              // row first matches zero rows and stages nothing.
              const claim = await tx.refund.updateMany({
                where: { id: refund.id, status: RefundStatus.PENDING },
                data: { status: RefundStatus.SUCCEEDED, updatedAt: new Date() },
              });
              if (claim.count !== 1) return false;
              // A row that was once failed gave its owed refund back; no-op otherwise.
              await resettleOwedOnLateSuccess(tx, refund.id);
              await applyRefundCascade(tx, {
                paymentId: refund.payment.id,
                refundId: refund.id,
                amountPaise: refund.amountPaise,
                reason: refund.reason ?? "Gateway refund reconciled",
                initiatedByUserId: null,
              });
              await reverseCreditsForPayment(
                refund.payment.id,
                tx,
                refund.amountPaise,
                refund.payment.amount,
                refund.id,
              );
              await settleRefundSeatTx(tx, refund.id);
              const notice = await notifyRefundProcessed(
                refund.payment.userId,
                {
                  ...notificationScope(refund.payment.organizationId),
                  amount: refund.amountPaise,
                  currency: refund.currency,
                  // The payer's money view, matching the other money bells.
                  dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
                },
                {
                  tx,
                  entityRef: `payment:${refund.payment.id}`,
                  required: refundNoticeOverride(
                    refund.reason,
                    refund.payment.userId,
                  ),
                },
              );
              bell = notice?.staged ?? null;
              emails = await stageRefundProcessedEmail(
                tx,
                receiptArgs,
                receipt,
              );
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
        await attemptRefundNotice(bell, emails);
        console.log(
          `✅ Real-id refund ${refund.id} (${refund.refundId}) confirmed settled at gateway and cascaded`,
        );
        reconciledCount++;
      } else if (gatewayRefund.status === RefundStatus.FAILED) {
        const claimed = await failRefund(refund.id, (tx) =>
          tx.refund.updateMany({
            where: { id: refund.id, status: RefundStatus.PENDING },
            data: {
              status: RefundStatus.FAILED,
              failureReason: "Gateway reports the refund failed",
              failedAt: new Date(),
            },
          }),
        );
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
      if (isUnknownAtGateway(error)) {
        unknownAtGateway.push(refund.id);
        skippedCount++;
        continue;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Error polling refund ${refund.id}:`, errorMessage);
    } finally {
      try {
        await prisma.$executeRaw`UPDATE "Refund" SET "lastReconciledAt" = now() WHERE id = ${refund.id}`;
      } catch (error) {
        errors.push(
          `Polling cursor Refund ${refund.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // A poison row is a per-row failure in the summary, never a failed run.
  const backstop = pastDeadline()
    ? { scanned: 0, redriven: 0, failed: 0, deadLettered: [] }
    : await redriveStrandedRefunds(
        limit,
        () => Date.now() >= startedAt + 12_000,
      );
  totalProcessed += backstop.scanned;

  // Stops starting hand-overs two seconds before the run's start deadline, which the failure notices keep.
  let discovery: RefundReconciliationResult["discovery"] = null;
  let checkpoint: string | undefined;
  try {
    const {
      errors: discoveryErrors,
      checkpoint: position,
      ...counts
    } = await discoverGatewayRefunds(() => Date.now() >= startedAt + 14_000);
    discovery = counts;
    checkpoint = position;
    errors.push(...discoveryErrors);
  } catch (error) {
    errors.push(
      `Refund discovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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

  if (unknownAtGateway.length > 0) {
    const message = `reconcile-pending-refunds: ${unknownAtGateway.length} PENDING refund(s) left PENDING because the gateway did not answer for them under these keys (unknown id, capture not readable as captured, or refund listing past the page bound); check the key mode and account before refunding again`;
    await reportStandingFinding(
      {
        key: "reconcile-pending-refunds:unknown-at-gateway",
        ids: unknownAtGateway,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "refund-reconcile.unknown-at-gateway",
          level: "error",
          tags: { provider: "razorpay" },
          extra: { refundIds: unknownAtGateway },
        }),
    );
  }

  if (ambiguousPlaceholders.length > 0) {
    const message = `Ambiguous placeholder refund(s) skipped in reconcile-pending-refunds (${ambiguousPlaceholders.length}): a same-amount gateway refund carries no reservation id`;
    await reportStandingFinding(
      {
        key: "reconcile-pending-refunds:ambiguous",
        ids: ambiguousPlaceholders,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          level: "warning",
          tags: { feature: "refund-reconcile" },
          extra: { ambiguous: ambiguousPlaceholders },
        }),
    );
  }

  try {
    await notifyFailedRefundsUnlocked(limit, pastDeadline);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    success: errors.length === 0,
    totalProcessed,
    reconciledCount,
    failedCount,
    skippedCount,
    unknownAtGateway: unknownAtGateway.length,
    failedGatewayDisabled,
    redrivenCount: backstop.redriven,
    redriveFailedCount: backstop.failed,
    redriveDeadLettered: backstop.deadLettered.length,
    discovery,
    ...(checkpoint === undefined ? {} : { checkpoint }),
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
    userId: string;
    organizationId: string | null;
    currency: string;
  },
): Promise<"bound" | "superseded"> {
  const nextStatus = mapGatewayRefundStatus(gatewayRefund.status);
  const mergedMetadata = {
    ...existingMetadata,
    ...(gatewayRefund.metadata ?? {}),
    reconciled_at: new Date().toISOString(),
  } as Prisma.InputJsonValue;

  let bell: StagedTrigger | null = null;
  let emails: StagedRecipientEmail[] = [];
  const receiptArgs = {
    userId: cascade.userId,
    paymentId: cascade.paymentId,
    amountPaise: cascade.amountPaise,
    currency: cascade.currency,
    required: refundNoticeKind(cascade.reason) !== null,
  };
  const receipt =
    nextStatus === RefundStatus.SUCCEEDED
      ? await prepareRefundProcessedEmail(receiptArgs).catch(() => null)
      : null;

  try {
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          bell = null;
          emails = [];
          const claim = await tx.refund.updateMany({
            where: { id: placeholderRowId, status: RefundStatus.PENDING },
            data: {
              refundId: gatewayRefund.refundId,
              status: nextStatus,
              metadata: mergedMetadata,
            },
          });
          if (claim.count === 0) return;
          if (nextStatus !== RefundStatus.SUCCEEDED) return;
          await applyRefundCascade(tx, {
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
          await settleRefundSeatTx(tx, placeholderRowId);
          const notice = await notifyRefundProcessed(
            cascade.userId,
            {
              ...notificationScope(cascade.organizationId),
              amount: cascade.amountPaise,
              currency: cascade.currency,
              dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
            },
            {
              tx,
              entityRef: `payment:${cascade.paymentId}`,
              required: refundNoticeOverride(cascade.reason, cascade.userId),
            },
          );
          bell = notice?.staged ?? null;
          emails = await stageRefundProcessedEmail(tx, receiptArgs, receipt);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    await attemptRefundNotice(bell, emails);
    return "bound";
  } catch (error) {
    if (!(
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )) {
      throw error;
    }
  }

  const winner = await prisma.refund.findUnique({
    where: { refundId: gatewayRefund.refundId },
    select: { id: true, paymentId: true },
  });
  const placeholder = await prisma.refund.findUnique({
    where: { id: placeholderRowId },
    select: { id: true, paymentId: true, dedupeKey: true, metadata: true },
  });
  if (!winner || !placeholder || winner.paymentId !== placeholder.paymentId) {
    // Collision outside the same payment is an integrity fault, not a race.
    throw new Error(
      `Refund id collision across payments while reconciling ${placeholderRowId} -> ${gatewayRefund.refundId}`,
    );
  }
  await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) => retireSupersededPlaceholderTx(tx, placeholder, winner.id),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
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

/**
 * Stranded SUCCEEDED refunds under the re-drive cap; raw because a missing JSON
 * key must count as zero attempts.
 */
function strandedRefundSqlWhere(updatedBefore: Date): Prisma.Sql {
  return Prisma.sql`status = 'SUCCEEDED'
      AND "cascadedAt" IS NULL
      AND "deletedAt" IS NULL
      AND "amountPaise" > 0
      AND "updatedAt" < ${updatedBefore}
      AND COALESCE(
        CASE jsonb_typeof(metadata -> 'cascadeRedriveAttempts')
          WHEN 'number' THEN (metadata ->> 'cascadeRedriveAttempts')::numeric
        END, 0) < ${MAX_CASCADE_REDRIVE_ATTEMPTS}`;
}

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
  pastDeadline: () => boolean,
): Promise<StrandedPass> {
  const startedAt = Date.now();
  // Credit restorations (amountPaise 0) settle in place and never cascade.
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Refund"
    WHERE ${strandedRefundSqlWhere(new Date(startedAt - STRANDED_AFTER_MS))}
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
    if (pastDeadline() || Date.now() - startedAt > STRANDED_BUDGET_MS) break;
    pass.scanned++;
    try {
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            await applyRefundCascade(tx, {
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
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      pass.redriven++;
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

/** FAILED refunds the payer has not heard about. */
const FAILED_REFUND_NOTICE_WHERE: Prisma.RefundWhereInput = {
  status: RefundStatus.FAILED,
  failedNotifiedAt: null,
};

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

async function notifyFailedRefundsUnlocked(
  limit = 10,
  pastDeadline = startDeadline(),
): Promise<FailedRefundNotifyResult> {
  const now = new Date();
  const failed =
    (await prisma.refund.findMany({
      where: FAILED_REFUND_NOTICE_WHERE,
      include: {
        payment: {
          select: {
            userId: true,
            organizationId: true,
            refundOwedKey: true,
            refundOwedAt: true,
          },
        },
      },
      orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
      take: limit,
    })) ?? [];

  let notified = 0;
  const failures: string[] = [];
  for (const refund of failed) {
    if (pastDeadline()) break;
    try {
      // An attempt of the refund the payment still owes is retried by the owed
      // sweep, so it is claimed silently; a spent marker pages ops instead.
      const owedAt = refund.payment.refundOwedAt;
      if (
        refund.payment.refundOwedKey &&
        owedAt &&
        refund.createdAt >= owedAt
      ) {
        await prisma.refund.updateMany({
          where: { id: refund.id, failedNotifiedAt: null },
          data: { failedNotifiedAt: now, failedAt: refund.failedAt ?? now },
        });
        continue;
      }
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

      const failedArgs = {
        userId: refund.payment.userId,
        paymentId: refund.paymentId,
        amountPaise: refund.amountPaise,
        currency: refund.currency,
      };
      const failedNotice = await prepareRefundFailedEmail(failedArgs).catch(
        () => null,
      );
      const staged = await prisma.$transaction(async (tx) => {
        const claim = await tx.refund.updateMany({
          where: {
            id: refund.id,
            status: RefundStatus.FAILED,
            failedNotifiedAt: null,
          },
          data: {
            failedNotifiedAt: now,
            failureReason: refund.failureReason ?? failureReason,
            failedAt: refund.failedAt ?? now,
          },
        });
        if (claim.count === 0) return null;
        const notice = await notifyRefundFailed(
          refund.payment.userId,
          {
            ...notificationScope(refund.payment.organizationId),
            amount: refund.amountPaise,
            currency: refund.currency,
            reason: failureReason,
            dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
          },
          { tx, entityRef: `refund:${refund.id}` },
        );
        const emails = await stageRefundFailedEmail(
          tx,
          failedArgs,
          failedNotice,
        );
        return { bell: notice?.staged ?? null, emails };
      });
      if (!staged) continue;
      notified++;
      if (staged.bell) await attemptTrigger(staged.bell);
      await attemptStagedEmails(
        staged.emails,
        MONEY_EMAIL_TYPES.REFUND_FAILED,
        EMAIL_BUDGET_MS.JOB,
      );
    } catch (error) {
      failures.push(
        `${refund.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await prisma.$executeRaw`UPDATE "Refund" SET "lastReconciledAt" = now() WHERE id = ${refund.id}`;
      } catch (stampError) {
        failures.push(
          `${refund.id} cursor: ${stampError instanceof Error ? stampError.message : String(stampError)}`,
        );
      }
    }
  }

  if (failures.length > 0)
    throw new Error(`Failed refund notices: ${failures.join("; ")}`);
  return { scanned: failed.length, notified };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
