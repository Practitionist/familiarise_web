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
import { isRazorpayUnknownRefundIdError } from "../../lib/payments/core/razorpay";
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
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

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
   * #1458 — the subset of `skippedCount` that was left alone because its
   * gateway is fenced off for this deployment. Reported separately so an
   * operator can tell "nothing to do" from "there is settled money we are not
   * polling because STRIPE_ENABLED is off".
   */
  skippedFenced: number;
  /**
   * FAMILIARISE_WEB-3V — the subset of `failedCount` whose gateway has no
   * record of the refund id (unknown id, or a test-mode id read with live
   * keys). Terminal: the row is moved to FAILED instead of polled forever.
   */
  failedUnknownId: number;
  /**
   * #1757 — the subset of `failedCount` retired because no live client exists
   * for the row's gateway (fenced or unimplemented) and it was over 24 h old.
   */
  failedGatewayDisabled: number;
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
  let skippedFenced = 0;
  let failedUnknownId = 0;
  let failedGatewayDisabled = 0;
  let totalProcessed = 0;
  const retiredNoClient: string[] = [];

  /**
   * #1458 — a PENDING refund on a gateway this deployment has fenced off is not
   * reconcilable: the gateway client is never constructed, so `listRefunds` /
   * `getRefund` throw, every fenced row lands in `errors`, and the whole run
   * reports `success: false` — a 500 from the cleanup route for a condition
   * that is deliberate configuration. `assertGatewayUsable` cannot be reused
   * here because it deliberately leaves refund LOOKUPS open, so that a Payment
   * already written against Stripe stays refundable after the fence goes up.
   * Skip the row, count it, and let the summary say so.
   */
  const isFencedGateway = (gateway: PaymentGateway): boolean =>
    gateway === PaymentGateway.STRIPE && process.env.STRIPE_ENABLED !== "true";

  /**
   * #1757 — a row no live client can ever settle (fenced or unimplemented
   * gateway) was skipped on every tick forever. Past 24 h it is FAILED with
   * `GATEWAY_DISABLED` through the same CAS the unknown-id path uses, which
   * re-opens the refundable balance; younger rows keep the skip.
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
      if (
        refund.payment.paymentGateway !== PaymentGateway.STRIPE &&
        refund.payment.paymentGateway !== PaymentGateway.RAZORPAY
      ) {
        if (await retireIfNoLiveClient(refund)) continue;
        console.log(
          `⏭️ Skipping refund ${refund.id} - unsupported gateway: ${refund.payment.paymentGateway}`,
        );
        skippedCount++;
        continue;
      }
      if (isFencedGateway(refund.payment.paymentGateway)) {
        if (await retireIfNoLiveClient(refund)) continue;
        console.log(
          `⏭️ Skipping refund ${refund.id} - ${refund.payment.paymentGateway} is fenced off for this deployment`,
        );
        skippedCount++;
        skippedFenced++;
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
        const bound = await bindGatewayRefundToPlaceholder(
          refund.id,
          matchingRefund,
          prismaMetadataObject(refund.metadata),
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
      if (
        refund.payment.paymentGateway !== PaymentGateway.STRIPE &&
        refund.payment.paymentGateway !== PaymentGateway.RAZORPAY
      ) {
        if (await retireIfNoLiveClient(refund)) continue;
        skippedCount++;
        continue;
      }
      if (isFencedGateway(refund.payment.paymentGateway)) {
        if (await retireIfNoLiveClient(refund)) continue;
        skippedCount++;
        skippedFenced++;
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
        const claimed = await prisma.$transaction(async (tx) => {
          // Claim by status: a re-entrant run or a webhook that settled the
          // row first matches zero rows and stages nothing.
          const claim = await tx.refund.updateMany({
            where: { id: refund.id, status: RefundStatus.PENDING },
            data: { status: RefundStatus.SUCCEEDED, updatedAt: new Date() },
          });
          if (claim.count !== 1) return false;
          const notice = await notifyRefundProcessed(
            refund.payment.userId,
            {
              ...notificationScope(refund.payment.organizationId),
              amount: refund.amountPaise,
              currency: refund.currency,
              dashboardUrl: `${getAppUrl()}/dashboard`,
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
        });
        if (!claimed) {
          console.log(
            `♻️ Real-id refund ${refund.id} (${refund.refundId}) was settled by another writer; nothing to mark`,
          );
          skippedCount++;
          continue;
        }
        await attemptRefundNotice(bell, emails);
        console.log(
          `✅ Real-id refund ${refund.id} (${refund.refundId}) confirmed settled at gateway; backstop cascade will complete it`,
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

  return {
    success: errors.length === 0,
    totalProcessed,
    reconciledCount,
    failedCount,
    skippedCount,
    skippedFenced,
    failedUnknownId,
    failedGatewayDisabled,
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
): Promise<"bound" | "superseded"> {
  const nextStatus = mapGatewayRefundStatus(gatewayRefund.status);
  const mergedMetadata = {
    ...existingMetadata,
    ...(gatewayRefund.metadata ?? {}),
    reconciled_at: new Date().toISOString(),
  } as Prisma.InputJsonValue;

  try {
    await prisma.refund.update({
      where: { id: placeholderRowId },
      data: {
        refundId: gatewayRefund.refundId,
        status: nextStatus,
        metadata: mergedMetadata,
      },
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
  const failed = await prisma.refund.findMany({
    where: {
      status: RefundStatus.FAILED,
      failedNotifiedAt: null,
    },
    include: { payment: { select: { userId: true, organizationId: true } } },
    orderBy: { createdAt: "asc" },
  });

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
      dashboardUrl: `${getAppUrl()}/dashboard`,
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
