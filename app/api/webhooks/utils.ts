import type { Tx } from "@/lib/prisma";
import prisma from "../../../lib/prisma";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  isLegalDisputeTransition,
  mapDisputeStatus,
} from "@/lib/payments/dispute-status";
import { Prisma, PaymentGateway, DisputeStatus } from "@prisma/client";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import { handlePayoutWebhook } from "@/lib/payments/payouts";
import { reportUnknownPayoutStatus } from "@/lib/payments/payouts/payout-service";
import { applyCappedOrgEarningReversal } from "@/lib/payments/payouts/earning-reversal-cas";
import {
  notifyRefundProcessed,
  notifyDisputeCreated,
  notifyDisputeResolved,
  attemptTrigger,
  type StagedTrigger,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import {
  notifyOrgInvoicePaid,
  notifyOrgWalletTopupConfirmed,
} from "@/lib/novu/org-workflows";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { toCurrencyEnum } from "@/lib/payments/validation/currency-guards";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import {
  confirmTopUp,
  walletCredit,
  walletDebit,
  WalletInsufficientFundsError,
} from "@/lib/api/organizations/wallet";
import {
  applyRefundCascade,
  mintInvoiceRefundCreditNote,
  mintRefundCreditNote,
  refundMemberOverageSidePayment,
  remainingOrgInvoiceCreditPaise,
  type ApplyRefundCascadeResult,
} from "@/lib/payments/operations/refund";
import { mintConsumerCreditNote } from "@/lib/payments/billing/consumer-invoice";
import { invoiceRefundDebits } from "@/lib/payments/billing/org-invoice-journal";
import { isPastGstCreditNoteCutoff } from "@/lib/compliance/gst-credit-note-cutoff";
import { releaseClawbackRecovery } from "@/lib/payments/payouts/clawback-recovery";
import { revokeReplayEntitlement } from "@/lib/payments/recording-entitlement";
import {
  applyReversal,
  consultantClawbackKey,
} from "@/lib/payments/operations/reversal-engine";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import {
  EMAIL_BUDGET_MS,
  MONEY_EMAIL_TYPES,
  stageRefundProcessedEmail,
} from "@/lib/email";
import {
  attemptStaged as attemptStagedEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";

// Re-export payment handlers from lib (architectural fix)
export {
  handlePaymentSuccess,
  handlePaymentFailure,
} from "@/lib/payments/webhooks/handlers";

/**
 * #813/#812 — defer sentinel for the refund-before-capture race. A handler
 * returns this (rather than throwing) when an event is processable but the row
 * it needs hasn't been written yet. The Razorpay dispatcher SKIPS
 * markWebhookEventProcessed on a defer, leaving the WebhookEvent
 * processed=false/error=null so the stuck-event sweeper re-drives it; a real
 * throw still records the error. See handleRefundCreated.
 */
export class DeferSignal {
  constructor(public readonly reason: string) {}
}

/**
 * Handle org-specific payment success (credit_purchase or invoice_payment).
 * These bypass the standard handlePaymentSuccess flow because they don't
 * involve appointments or booking confirmations.
 *
 * Razorpay order notes use `organizationId` as the canonical key — the
 * legacy `orgProfileId` alias pointed at the now-deleted OrganizationProfile
 * table and would silently corrupt audit writes if it ever held a stale
 * value. Producers (initiateTopUp, invoice-pay route) set
 * `notes.organizationId` directly.
 */
/**
 * #1654 — the post-commit half of a bell staged inside a transaction. A
 * function parameter, because the variable's only assignment happens inside
 * the tx callback, which TS's initializer narrowing cannot see past.
 */
async function attemptStaged(staged: StagedTrigger | null): Promise<void> {
  if (staged) await attemptTrigger(staged);
}

export async function handleOrgPaymentSuccess(
  notes: Record<string, string>,
  razorpayPaymentId?: string,
  /**
   * Authoritative amount captured at the gateway (paise). Must be passed
   * by the caller so we can reject `notes.amountPaise` tampering for
   * top-ups and reject under-paid invoices. When undefined (e.g. legacy
   * `order.paid` path that has no payment id) we fall back to trusting
   * notes but refuse to mark an invoice PAID.
   */
  gatewayAmountPaise?: number,
): Promise<void> {
  // credit_purchase routes to WalletEntry via `confirmTopUp` from
  // lib/api/organizations/wallet.ts (idempotent on providerOrderId).
  // invoice_payment transitions OrganizationInvoice.status ISSUED → PAID.
  if (notes.type === "credit_purchase") {
    const { walletEntryOrderId, organizationId, amountPaise } = notes;
    if (!walletEntryOrderId) {
      console.error("[Webhook] credit_purchase missing walletEntryOrderId");
      return;
    }
    if (!razorpayPaymentId) {
      // order.paid carries the order-level event without a payment id
      // on this entity; we still need a payment id to record on the
      // WalletEntry. Skip — payment.captured (which DOES include the
      // payment id) handles the same logical event idempotently.
      console.log(
        `[Webhook] credit_purchase ${walletEntryOrderId} order-level event skipped; awaiting payment.captured`,
      );
      return;
    }
    const paise = Number(amountPaise);
    if (!Number.isFinite(paise) || paise <= 0) {
      console.error(
        `[Webhook] credit_purchase ${walletEntryOrderId} has invalid amountPaise notes value: ${amountPaise}`,
      );
      return;
    }
    // Defence-in-depth: `notes.amountPaise` is mutable metadata we
    // attach to the Razorpay order. Verify it matches what was actually
    // captured before crediting the wallet. A mismatch means either a
    // gateway anomaly or a tampered order — we log + return 200 so
    // Razorpay stops retrying, but we do NOT credit the wallet.
    if (gatewayAmountPaise !== undefined && paise !== gatewayAmountPaise) {
      console.error(
        `[Webhook] credit_purchase ${walletEntryOrderId} notes.amountPaise=${paise} ≠ gatewayAmount=${gatewayAmountPaise}. Skipping wallet credit.`,
      );
      if (organizationId) {
        await prisma.orgAuditLog
          .create({
            data: {
              organizationId,
              actorMembershipId: null,
              category: "WALLET",
              action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP,
              description: `Top-up amount mismatch for order ${walletEntryOrderId}: notes=${paise}p gateway=${gatewayAmountPaise}p`,
              details: {
                walletEntryOrderId,
                providerPaymentId: razorpayPaymentId,
                notesAmountPaise: paise,
                gatewayAmountPaise,
              },
            },
          })
          .catch((err) =>
            console.error(
              "[Webhook] Failed to write WALLET topup mismatch audit log:",
              err,
            ),
          );
      }
      return;
    }
    try {
      const result = await confirmTopUp(prisma, {
        providerOrderId: walletEntryOrderId,
        providerPaymentId: razorpayPaymentId,
        amountPaise: paise,
      });
      console.log(
        `[Webhook] credit_purchase confirmed=${result.confirmed} order=${walletEntryOrderId} org=${organizationId ?? "?"} balanceAfter=${result.balanceAfter ?? "?"}`,
      );
      if (organizationId && result.confirmed) {
        await prisma.orgAuditLog
          .create({
            data: {
              organizationId,
              actorMembershipId: null,
              category: "WALLET",
              action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP_CONFIRMED,
              description: `Top-up confirmed: ₹${(paise / 100).toLocaleString("en-IN")}`,
              details: {
                walletEntryOrderId,
                providerPaymentId: razorpayPaymentId,
                amountPaise: paise,
              },
            },
          })
          .catch((err) =>
            console.error(
              "[Webhook] Failed to write WALLET_TOPUP_CONFIRMED audit log:",
              err,
            ),
          );

        // Novu bell notification to OWNERs. Look up org context inline
        // — the webhook is outside the HTTP session scope, so we can't
        // lean on `requireOrgAccess` to hand us `access.org`.
        const orgRow = await prisma.organization.findUnique({
          where: { id: organizationId },
          select: {
            name: true,
            billingAccount: { select: { walletBalance: true, currency: true } },
          },
        });
        if (orgRow) {
          notifyOrgWalletTopupConfirmed(organizationId, {
            orgName: orgRow.name,
            amountPaise: paise,
            currency: orgRow.billingAccount?.currency ?? "INR",
            newBalancePaise: orgRow.billingAccount?.walletBalance ?? 0,
            dashboardUrl: `${getAppUrl()}/dashboard/organization/${organizationId}/billing`,
          }).catch((err) =>
            console.error("[notifyOrgWalletTopupConfirmed] failed:", err),
          );
        }
      }
    } catch (err) {
      console.error(
        `[Webhook] confirmTopUp failed for ${walletEntryOrderId}:`,
        err,
      );
      throw err; // bubble so the webhook record retains the error for retry
    }
  } else if (notes.type === "invoice_payment") {
    const { invoiceId, organizationId } = notes;
    if (!invoiceId) {
      console.error("[Webhook] invoice_payment missing invoiceId");
      return;
    }

    // Verify the captured amount matches what was billed before we
    // flip the invoice to PAID. Without this, a tampered or partial
    // capture could mark an invoice paid for less than what was owed.
    // If we don't have a gateway amount (order-level event), we wait
    // for the payment.captured event — no ISSUED→PAID without proof.
    if (gatewayAmountPaise === undefined) {
      console.log(
        `[Webhook] invoice_payment ${invoiceId} deferred: no gateway amount (awaiting payment.captured)`,
      );
      return;
    }
    const invoiceRow = await prisma.organizationInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        totalPaise: true,
        status: true,
        displayCurrency: true,
        organizationId: true,
      },
    });
    if (!invoiceRow) {
      console.error(`[Webhook] invoice_payment ${invoiceId} not found`);
      return;
    }
    if (invoiceRow.totalPaise !== gatewayAmountPaise) {
      console.error(
        `[Webhook] invoice_payment ${invoiceId} totalPaise=${invoiceRow.totalPaise} ≠ gatewayAmount=${gatewayAmountPaise}. Not marking PAID.`,
      );
      if (organizationId) {
        await prisma.orgAuditLog
          .create({
            data: {
              organizationId,
              actorMembershipId: null,
              category: "INVOICE",
              action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
              description: `Invoice ${invoiceId} captured amount mismatch: billed=${invoiceRow.totalPaise}p, captured=${gatewayAmountPaise}p`,
              details: {
                invoiceId,
                providerPaymentId: razorpayPaymentId ?? null,
                totalPaise: invoiceRow.totalPaise,
                gatewayAmountPaise,
              },
            },
          })
          .catch((err) =>
            console.error(
              "[Webhook] Failed to write invoice amount-mismatch audit log:",
              err,
            ),
          );
      }
      return;
    }

    const resolvedOrgId = invoiceRow.organizationId ?? organizationId;

    // LED-1: invoice claim + INVOICE_PAID settlement write must be atomic.
    // Before this PR the settlement write was a fire-and-forget after the
    // updateMany — so a transient DB error on the settlement insert left
    // the invoice marked PAID with no ledger row, and the nightly
    // reconciler would flag drift it could not auto-remediate. Both writes
    // now share a transaction. Audit + Novu notifications stay best-effort
    // outside the tx — they're operator surfaces, not ledger.
    let claimedCount = 0;
    try {
      const txResult = await prisma.$transaction(async (tx) => {
        const paidAt = new Date();
        const claimed = await tx.organizationInvoice.updateMany({
          where: { id: invoiceId, status: { in: ["ISSUED", "OVERDUE"] } },
          data: {
            status: "PAID",
            paidAt,
            providerPaymentOrderId: null,
            ...(razorpayPaymentId
              ? { providerPaymentId: razorpayPaymentId }
              : {}),
          },
        });
        if (claimed.count === 0) {
          return { count: 0 as const };
        }
        if (resolvedOrgId) {
          // #771 D1/D5 — double-entry (dual-write): org pays the invoice; clear
          // the receivable accrued at booking time (INR underlying).
          //   Dr CASH   Cr ORG_RECEIVABLE(org)
          if (invoiceRow.totalPaise > 0) {
            await postLedgerTxn(tx, {
              idempotencyKey: `invoicepaid:${invoiceId}`,
              kind: "INVOICE_PAID",
              invoiceId,
              postings: [
                {
                  account: { kind: "CASH" },
                  direction: "DEBIT",
                  amountPaise: invoiceRow.totalPaise,
                },
                {
                  account: {
                    kind: "ORG_RECEIVABLE",
                    organizationId: resolvedOrgId,
                  },
                  direction: "CREDIT",
                  amountPaise: invoiceRow.totalPaise,
                },
              ],
            });
          }
          await dispatchWebhookEvent({
            prisma: tx,
            organizationId: resolvedOrgId,
            eventType: "invoice.paid",
            payload: {
              invoiceId: invoiceRow.id,
              invoiceNumber: invoiceRow.invoiceNumber,
              paidPaise: Number(invoiceRow.totalPaise),
              paymentId: razorpayPaymentId ?? invoiceRow.id,
              settledAt: paidAt.toISOString(),
            },
          });
        }
        // #775 — CHARGE_ORG overage events on this invoice's lines were ACCRUED
        // at rollup; the org has now paid, so flip them ACCRUED → CHARGED.
        await tx.overageEvent.updateMany({
          where: {
            overageBehavior: "CHARGE_ORG",
            chargeStatus: "ACCRUED",
            invoiceLineItem: { invoiceId },
          },
          data: { chargeStatus: "CHARGED" },
        });
        if (resolvedOrgId) {
          await tx.organizationEarnings.updateMany({
            where: { organizationId: resolvedOrgId, status: "PENDING_TRUST" },
            data: { status: "PENDING" },
          });
          await tx.consultantEarnings?.updateMany({
            where: {
              payment: { organizationId: resolvedOrgId },
              status: "PENDING_TRUST",
            },
            data: { status: "PENDING" },
          });
        }
        return { count: claimed.count };
      });
      claimedCount = txResult.count;
    } catch (err) {
      // Webhook delivery is at-least-once; throwing causes Razorpay to
      // retry. The tx already rolled back so a retry sees the original
      // ISSUED/OVERDUE state and tries again cleanly.
      console.error(
        `[Webhook] INVOICE_PAID transaction failed for ${invoiceId}; rolling back:`,
        err,
      );
      throw err;
    }

    if (claimedCount === 0) {
      console.log(
        `[Webhook] Invoice ${invoiceId} already PAID — skipping (idempotent)`,
      );
      return;
    }

    console.log(`[Webhook] Invoice paid: ${invoiceId}`);

    if (resolvedOrgId) {
      await prisma.orgAuditLog
        .create({
          data: {
            organizationId: resolvedOrgId,
            actorMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
            description: `Invoice ${invoiceId} paid via webhook`,
            details: {
              invoiceId,
              providerPaymentId: razorpayPaymentId ?? null,
            },
          },
        })
        .catch((err) =>
          console.error(
            "[Webhook] Failed to write INVOICE_PAID audit log:",
            err,
          ),
        );

      // Novu bell notification to OWNERs. Look up the invoice number +
      // org name here rather than passing them down — the webhook entry
      // site doesn't have them.
      const ctx = await prisma.organizationInvoice.findUnique({
        where: { id: invoiceId },
        select: {
          invoiceNumber: true,
          paidAt: true,
          organization: { select: { name: true } },
        },
      });
      if (ctx) {
        notifyOrgInvoicePaid(resolvedOrgId, {
          invoiceNumber: ctx.invoiceNumber,
          orgName: ctx.organization.name,
          totalPaise: invoiceRow.totalPaise,
          currency: invoiceRow.displayCurrency,
          paidAt: (ctx.paidAt ?? new Date()).toISOString(),
          dashboardUrl: `${getAppUrl()}/dashboard/organization/${resolvedOrgId}/billing`,
        }).catch((err) => console.error("[notifyOrgInvoicePaid] failed:", err));
      }
    }
  }
}

/**
 * Handle org-specific payment FAILURE (credit_purchase or invoice_payment).
 *
 * The legacy `handlePaymentFailure` path only knows about the B2C
 * `Payment` table — when a user's wallet top-up or invoice-payment fails
 * at the gateway, there is no `Payment` row for it. Without this
 * handler, a `payment.failed` webhook for an org top-up would silently
 * log "Payment record not found" and leave the pending `WalletEntry`
 * placeholder stuck in the DB forever (the cleanup cron would GC it
 * eventually, but we want to flip state immediately for a snappy UX).
 *
 * For top-ups: the placeholder WalletEntry (deltaPaise=0, status
 * expressed via notes + absence of providerPaymentId) is deleted so the
 * caller sees an immediate "payment failed — please retry" state on
 * next refresh. `confirmTopUp` is the only path that converts a
 * placeholder to a live wallet credit, so deleting here is safe.
 *
 * For invoices: we clear `providerPaymentOrderId` so the next "Pay"
 * click at the UI creates a fresh Razorpay order (the idempotency
 * guard we introduced in Phase 1 reused the old order id; a failed
 * order must be discarded before retry).
 */
export async function handleOrgPaymentFailure(
  notes: Record<string, string>,
  providerPaymentId?: string,
): Promise<void> {
  if (notes.type === "credit_purchase") {
    const { walletEntryOrderId, organizationId } = notes;
    if (!walletEntryOrderId) {
      console.error(
        "[Webhook] credit_purchase.failed missing walletEntryOrderId",
      );
      return;
    }
    // Only delete placeholders that were never confirmed. A confirmed
    // top-up has status=CONFIRMED + providerPaymentId set; a pending
    // placeholder has status=PENDING.
    const deleted = await prisma.walletTopUp.deleteMany({
      where: {
        providerOrderId: walletEntryOrderId,
        status: "PENDING",
        providerPaymentId: null,
      },
    });
    console.log(
      `[Webhook] credit_purchase.failed placeholder deleted (count=${deleted.count}) order=${walletEntryOrderId}`,
    );
    if (organizationId && deleted.count > 0) {
      await prisma.orgAuditLog
        .create({
          data: {
            organizationId,
            actorMembershipId: null,
            category: "WALLET",
            action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP,
            description: `Top-up failed at gateway: order ${walletEntryOrderId}`,
            details: {
              walletEntryOrderId,
              providerPaymentId: providerPaymentId ?? null,
              outcome: "failed",
            },
          },
        })
        .catch((err) =>
          console.error(
            "[Webhook] Failed to write WALLET_TOPUP failure audit log:",
            err,
          ),
        );
    }
  } else if (notes.type === "invoice_payment") {
    const { invoiceId, organizationId } = notes;
    if (!invoiceId) {
      console.error("[Webhook] invoice_payment.failed missing invoiceId");
      return;
    }
    // Clear the stored order id so the UI retry creates a fresh one.
    // Leave the invoice status untouched (still ISSUED/OVERDUE).
    await prisma.organizationInvoice.updateMany({
      where: {
        id: invoiceId,
        status: { in: ["ISSUED", "OVERDUE"] },
      },
      data: { providerPaymentOrderId: null },
    });
    console.log(
      `[Webhook] invoice_payment.failed cleared provider order id for invoice ${invoiceId}`,
    );
    if (organizationId) {
      await prisma.orgAuditLog
        .create({
          data: {
            organizationId,
            actorMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
            description: `Invoice ${invoiceId} payment failed at gateway`,
            details: {
              invoiceId,
              providerPaymentId: providerPaymentId ?? null,
              outcome: "failed",
            },
          },
        })
        .catch((err) =>
          console.error(
            "[Webhook] Failed to write invoice-payment-failed audit log:",
            err,
          ),
        );
    }
  }
}

// #1134 P1-2 — these three moved to lib/webhooks/event-log.ts so lib/ code (the
// Stream dispatch, which the stuck-event sweeper drives) can use them without
// importing from app/. Re-exported here so every existing caller is unchanged.
export {
  isDbHealthy,
  logWebhookEvent,
  markWebhookEventProcessed,
} from "@/lib/webhooks/event-log";

// ============================================================================
// Refund Webhook Handlers
// ============================================================================

/**
 * Handle refund created/processed event.
 *
 * Dispatches to one of three branches based on what the refund is paying
 * back:
 *   1. B2C appointment payment (`Payment` row keyed on `paymentIntent`):
 *      reverse consultant earnings + referral credits (legacy path).
 *   2. Enterprise wallet top-up (`WalletEntry.providerPaymentId`):
 *      credit a compensating REFUND WalletEntry so the wallet balance
 *      decreases and FundingLedger stays balanced.
 *   3. Enterprise invoice payment (`OrganizationInvoice.providerPaymentId`):
 *      mark the invoice REFUNDED and reverse any bookings charged to it
 *      (program utilisation → wallet credit, if applicable).
 *
 * If the webhook resolves to none of the above, we log and return.
 * `providerPaymentId` (Razorpay `pay_<…>`) is optional and only used by
 * the org-level branches.
 */
export async function handleRefundCreated(
  refundId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
  status: string,
  providerPaymentId?: string,
  notes?: Record<string, string>,
) {
  // Serializable + retry — the contract `applyRefundCascade` documents for
  // every driver ("Caller must pass a transaction client; the cascade itself
  // has no prisma.$transaction wrapper because it is meant to compose with
  // the caller's tx (Serializable required for race-safety)"). The app path
  // (refundPayment Phase 3b) and the backstop cron already comply; this
  // webhook-driven cascade ran under READ COMMITTED, so two distinct partial
  // refunds on one payment could interleave their earnings-reversal
  // read-modify-writes and silently lose an increment — overstating
  // readyAmount and over-paying the next payout batch. All gateway lookups
  // are hoisted into the dispatcher before this call, so no network I/O sits
  // inside the tx.
  // #1654 — the bell is staged inside the tx and sent only after COMMIT.
  let stagedNotification: StagedTrigger | null = null;
  // #1653 — the refund receipt email rides the same outbox: staged through
  // `tx`, attempted after commit. A retry re-runs the callback, so reset.
  let stagedEmails: StagedRecipientEmail[] = [];
  // A side-payment the cascade owes back; refunded only after this tx commits.
  let overageDue: ApplyRefundCascadeResult["memberOverageRefundDue"] = null;
  let overagePaymentId = "";
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        stagedEmails = [];
        overageDue = null;
        // A retried attempt must not inherit a bell staged by the aborted one.
        stagedNotification = null;
        // Find the payment (B2C appointment path).
        //
        // #1353 — match on EITHER id. A refund webhook carries only the gateway's
        // `pay_…` payment id, so the dispatcher had to translate it into our order
        // id with a live `payments.fetch`; when that call failed it passed the
        // `pay_…` id through unchanged and a lookup keyed solely on `paymentIntent`
        // could never match it. The refund then deferred and was re-driven for up
        // to a week against a payment that had been captured all along. Now the id
        // the webhook actually carries is itself a key.
        //
        // Deliberately NOT filtered on `deletedAt: null`: the lookup this replaced
        // was a `findUnique` on `paymentIntent`, which reached soft-deleted rows
        // too. A Payment soft-deleted after capture still owes its refund event a
        // hearing — excluding it would defer the webhook and give up on it after
        // 168h, which is a money outcome, not a tidier query.
        const payment = await tx.payment.findFirst({
          where: {
            OR: [
              { paymentIntent: paymentIntentId },
              ...(providerPaymentId
                ? [{ gatewayPaymentId: providerPaymentId }]
                : []),
            ],
          },
        });

        if (!payment) {
          // Fall through to enterprise branches. We need the original
          // provider payment id (`pay_<…>`) to look up org-level rows.
          if (!providerPaymentId) {
            console.warn(
              `Payment not found for refund ${refundId} and no providerPaymentId supplied; cannot dispatch org-level refund`,
            );
            return;
          }

          // --- Enterprise wallet top-up refund ---
          const topUp = await tx.walletTopUp.findFirst({
            where: { providerPaymentId, status: "CONFIRMED" },
            select: {
              id: true,
              billingAccountId: true,
              amountPaise: true,
              providerOrderId: true,
            },
          });
          if (topUp) {
            const mapped = mapGatewayRefundStatus(status);
            if (mapped === "SUCCEEDED") {
              // Clamp: cannot refund more than was credited to this wallet.
              const refundAmt = Math.min(amount, topUp.amountPaise);
              const acct = await tx.billingAccount.findUniqueOrThrow({
                where: { id: topUp.billingAccountId },
                select: { currency: true, ownerOrgId: true },
              });
              // Reverse the top-up's double-entry: Dr WALLET / Cr CASH. The
              // wallet liability we owe the org shrinks; platform cash returns
              // to the gateway. postLedgerTxn is idempotent on idempotencyKey,
              // so a webhook redelivery (or two racing workers) is a no-op —
              // this replaces the old "already booked?" WalletEntry probe.
              //
              // Keyed on the GATEWAY REFUND id, not the payment: Razorpay allows
              // N partial refunds per payment, and a payment-scoped key made the
              // second partial refund a silent no-op — real cash left via the
              // gateway with no WALLET debit and no receivable (platform loss).
              const posted = await postLedgerTxn(tx, {
                idempotencyKey: `topup-refund:${refundId}`,
                kind: "TOPUP_REFUND",
                description: `Refund for top-up ${topUp.providerOrderId} (gateway refund ${refundId})`,
                // #783 — ledger is INR-only; never key accounts by acct.currency.
                // Must mirror the INR-keyed top-up posting (lib/api/organizations/
                // wallet.ts) so the refund reversal nets against the same account.
                postings: [
                  {
                    account: {
                      kind: "WALLET",
                      organizationId: acct.ownerOrgId,
                    },
                    direction: "DEBIT",
                    amountPaise: refundAmt,
                  },
                  {
                    account: { kind: "CASH" },
                    direction: "CREDIT",
                    amountPaise: refundAmt,
                  },
                ],
              });
              if (!posted.created) {
                console.log(
                  `💸 Top-up refund already booked for payment ${providerPaymentId}, skipping`,
                );
                return;
              }
              // Decrement the cached wallet balance to match the journal. This
              // can drive the balance negative if the org already spent the
              // credited funds — that is a real reconcile signal (the org owes
              // back more than it holds), not an error to swallow here.
              //
              // Intentionally NOT inserting a `Refund` row for org-level
              // refunds: Refund.paymentId is NOT NULL and is scoped to the B2C
              // `Payment` table. The TOPUP_REFUND journal transaction
              // (idempotencyKey topup-refund:<gateway refund id>) is the
              // authoritative record; reconcile jobs index on it.
              // #1093 §2 (decision 2026-08-13) — the wallet floor WINS. The old
              // unconditional decrement could drive walletBalance below zero when
              // the org had already spent the credited funds, which the
              // billing_account_wallet_nonnegative CHECK rejects — rolling this
              // webhook back and redelivering it into the same failure forever.
              // Claw back only what the wallet still holds; the shortfall books
              // as an ORG_RECEIVABLE posting (the org owes the platform), which
              // reconciliation actually consumes — a negative cached balance is a
              // signal nothing reads.
              const account = await tx.billingAccount.findUniqueOrThrow({
                where: { id: topUp.billingAccountId },
                select: { walletBalance: true, ownerOrgId: true },
              });
              const balancePaise = Number(account.walletBalance ?? 0);
              const desiredClawbackPaise = Math.min(
                Math.max(balancePaise, 0),
                refundAmt,
              );
              // Conditional decrement, not read-modify-write: under contention
              // the balance may have moved below our snapshot. If the guard
              // misses, treat the whole refund as shortfall (receivable) rather
              // than relying on the nonnegative CHECK to abort the tx.
              let clawbackPaise = desiredClawbackPaise;
              if (desiredClawbackPaise > 0) {
                const decremented = await tx.billingAccount.updateMany({
                  where: {
                    id: topUp.billingAccountId,
                    walletBalance: { gte: desiredClawbackPaise },
                  },
                  data: { walletBalance: { decrement: desiredClawbackPaise } },
                });
                if (decremented.count === 0) {
                  clawbackPaise = 0;
                }
              }
              const shortfallPaise = refundAmt - clawbackPaise;
              if (shortfallPaise > 0 && account.ownerOrgId) {
                await postLedgerTxn(tx, {
                  idempotencyKey: `topup-refund-shortfall:${refundId}`,
                  kind: "TOPUP_REFUND",
                  description:
                    "Top-up refunded after the credited funds were spent — unrecovered portion receivable from the org",
                  postings: [
                    {
                      account: {
                        kind: "ORG_RECEIVABLE",
                        organizationId: account.ownerOrgId,
                      },
                      direction: "DEBIT",
                      amountPaise: shortfallPaise,
                    },
                    {
                      account: {
                        kind: "WALLET",
                        organizationId: account.ownerOrgId,
                      },
                      direction: "CREDIT",
                      amountPaise: shortfallPaise,
                    },
                  ],
                });
              }
              const shortfallNote =
                shortfallPaise > 0
                  ? `; ${shortfallPaise} paise booked as ORG_RECEIVABLE`
                  : "";
              console.log(
                `💸 Top-up refund ${refundId} booked: -${clawbackPaise} paise on billingAccount ${topUp.billingAccountId}${shortfallNote}`,
              );
            }
            return;
          }

          // --- Enterprise invoice refund ---
          const invoice = await tx.organizationInvoice.findFirst({
            where: { providerPaymentId },
            select: {
              id: true,
              organizationId: true,
              invoiceNumber: true,
              subtotalPaise: true,
              totalPaise: true,
              status: true,
            },
          });
          if (invoice) {
            const mapped = mapGatewayRefundStatus(status);
            if (mapped === "SUCCEEDED") {
              // Per-refund idempotency — keyed on the LEDGER JOURNAL, not the
              // credit note. The journal (`invoice-refund:<refundId>`) is the
              // one write that happens for EVERY booked refund, while
              // mintInvoiceRefundCreditNote legitimately returns null for DRAFT/
              // unissued invoices — a CN-only probe let redeliveries of those
              // re-run the audit log and (pre-#1128-fix) double the wallet
              // credit. postLedgerTxn's own idempotency stays as the second
              // layer; this probe just short-circuits before any side effects.
              // (The old invoice-status guard collapsed distinct refunds: the
              // first partial flipped the invoice REFUNDED and every later
              // partial was skipped wholesale — real cash left via the gateway
              // with no credit note, no wallet credit, no journal.)
              const alreadyBooked = await tx.ledgerTransaction.findUnique({
                where: { idempotencyKey: `invoice-refund:${refundId}` },
                select: { id: true },
              });
              if (alreadyBooked) {
                console.log(
                  `💸 Invoice refund ${refundId} already booked, skipping`,
                );
                return;
              }

              // #776 / PR#785 review — mint the GST credit note (Sec 34) for the
              // refunded invoice. One per gateway refund, idempotent on refundId.
              const { creditNoteId } = await mintInvoiceRefundCreditNote(tx, {
                invoiceId: invoice.id,
                refundId,
                amountPaise: amount,
                reason: `Invoice ${invoice.invoiceNumber} refund`,
              });

              // Flip to REFUNDED only once cumulative credit notes cover the
              // invoice total; partial refunds keep it PAID.
              const remainingCredit = await remainingOrgInvoiceCreditPaise(
                tx,
                invoice,
              );
              if (remainingCredit <= 0 && invoice.status !== "REFUNDED") {
                await tx.organizationInvoice.updateMany({
                  where: { id: invoice.id, status: invoice.status },
                  data: { status: "REFUNDED" },
                });
              }
              // NOTE: Booking-level utilization reversal is keyed on
              // individual Payment ids (BookingUtilization.paymentId @unique),
              // not on the invoice. Invoices that roll up many bookings do
              // not have a single paymentId to feed `reverseBookingUtilization`
              // — a follow-up phase (after the invoice-line-item schema lands)
              // will iterate over linked line-items and reverse each one
              // individually. For now, the balanced reversal journal below plus
              // the INVOICE_REFUNDED audit log is the guaranteed bookkeeping;
              // the operator runbook calls out bookings that may need manual
              // reversal.
              await tx.orgAuditLog
                .create({
                  data: {
                    organizationId: invoice.organizationId,
                    actorMembershipId: null,
                    category: "INVOICE",
                    action: AUDIT_ACTIONS.INVOICE.INVOICE_REFUNDED,
                    description: `Invoice ${invoice.invoiceNumber} refunded (${refundId}, ${amount} ${currency})`,
                    details: {
                      invoiceId: invoice.id,
                      refundId,
                      amount,
                      currency,
                      providerPaymentId,
                    },
                  },
                })
                .catch((err) =>
                  console.error(
                    `⚠️ Failed to write INVOICE_REFUNDED audit log:`,
                    err,
                  ),
                );
              // Balanced reversal journal. The credit side goes wherever the
              // value went: back to CASH when the gateway returns the money, or
              // to the org's WALLET when the refund is granted as in-app credit
              // (fundingSource WALLET). The debit side comes from invoiceRefundDebits.
              //
              // #1128 (doctrine §1) — no swallow: a failed journal or wallet
              // credit propagates, the tx rolls back and the CN is never minted
              // without its money truth. The stuck-event sweeper re-drives the
              // errored row and the `invoice-refund:<refundId>` key keeps that safe.
              const ba = await tx.billingAccount.findFirst({
                where: { ownerOrgId: invoice.organizationId },
                select: { id: true, fundingSource: true },
              });
              const creditAsWallet =
                !!ba &&
                ba.fundingSource === "WALLET" &&
                !!invoice.organizationId;
              await postLedgerTxn(tx, {
                idempotencyKey: `invoice-refund:${refundId}`,
                kind: "INVOICE_REFUND",
                invoiceId: invoice.id,
                description: `Refund of invoice ${invoice.invoiceNumber} (gateway refund ${refundId})`,
                postings: [
                  ...(await invoiceRefundDebits(tx, {
                    invoiceId: invoice.id,
                    organizationId: invoice.organizationId,
                    amountPaise: amount,
                    creditNoteId,
                  })),
                  creditAsWallet
                    ? {
                        account: {
                          kind: "WALLET",
                          organizationId: invoice.organizationId,
                        },
                        direction: "CREDIT",
                        amountPaise: amount,
                      }
                    : {
                        account: { kind: "CASH" },
                        direction: "CREDIT",
                        amountPaise: amount,
                      },
                ],
              });
              if (creditAsWallet && ba) {
                // Cache mirror of the Cr WALLET leg above — written only after
                // the journal succeeded so the two can never diverge here.
                await walletCredit(tx, {
                  billingAccountId: ba.id,
                  amountPaise: amount,
                  reason: "REFUND",
                  providerPaymentId,
                  notes: `Invoice ${invoice.invoiceNumber} refund (${refundId})`,
                });
              }
              console.log(
                `💸 Invoice refund ${refundId} booked for invoice ${invoice.id}`,
              );
            }
            return;
          }

          // #813/#812 — the refund references a payment we can't find on ANY path.
          // The common cause is ordering: `refund.created` arrived before the
          // `payment.captured` that creates the Payment row. A plain return ACKs the
          // event (processed=true/error=null) so it never re-runs; a throw stamps
          // error=true which the sweeper skips (it only re-drives error=null) — both
          // are permanent death on Razorpay (no redelivery after a 200). Instead
          // DEFER: the dispatcher skips the mark and the sweeper re-drives
          // until the payment lands (or the terminal age cap gives up).
          return new DeferSignal(
            `refund-before-capture: payment not yet recorded for refund ${refundId} (paymentIntent=${paymentIntentId}, providerPaymentId=${providerPaymentId})`,
          );
        }

        // Check if refund already exists
        const existingRefund = await tx.refund.findUnique({
          where: { refundId },
        });

        // FIX #4: Extract refund side effects into a helper so they run on BOTH
        // new refund creation AND status transitions (e.g. PENDING → SUCCEEDED).
        // FIX P2-1: Accepts refund amount for partial-refund-aware credit restoration.
        const runRefundSideEffects = async (
          paymentId: string,
          refundStatus: string,
          refundRowId: string,
          refundAmt?: number,
          originalPaymentAmt?: number,
        ) => {
          if (mapGatewayRefundStatus(refundStatus) !== "SUCCEEDED") return;

          // #776 — route gateway refunds through the canonical cascade so card/app/cron
          // refunds share ONE engine: earnings + funding-leg + wallet + ledger +
          // booking-utilization + GST credit-note reversal, idempotent on
          // `Refund.cascadedAt`. This replaces the old earnings-only `refundEarnings`
          // path, which left the refund ledger posting + leg/wallet reversal undone on
          // gateway refunds (a divergence from the app/cron paths). The cascade allows
          // PAID→REFUNDED, so the legacy `forceRefund` override is no longer needed.
          try {
            const cascade = await applyRefundCascade(tx, {
              paymentId,
              refundId: refundRowId,
              amountPaise: refundAmt ?? originalPaymentAmt ?? 0,
              reason: "Gateway refund",
              initiatedByUserId: null,
            });
            overageDue = cascade.memberOverageRefundDue;
            overagePaymentId = paymentId;
            console.log(`💰 Refund cascade applied for payment ${paymentId}`);
          } catch (cascadeError) {
            // #776 / PR#785 review — do NOT swallow. The cascade is idempotent
            // (Refund.cascadedAt, claimed at its start) and atomic, so rethrowing rolls
            // the tx back (the claim reverts) and the gateway redelivery / cascadedAt
            // backstop cron retry it — instead of committing a partial refund (e.g.
            // earnings reversed but the GST credit note un-minted, with no durable retry).
            console.error(
              `⚠️ Refund cascade failed for payment ${paymentId}:`,
              cascadeError,
            );
            throw cascadeError;
          }

          // Referral-credit restoration is NOT part of the cascade (v2 referral
          // ledger) — it runs here, and in the app path at the end of refund.ts
          // Phase 3b. It must run AFTER the Refund row reads SUCCEEDED, because it
          // derives its restoration target from the cumulative SUCCEEDED refund
          // total for the payment.
          //
          // This used to swallow its error, alone among the steps in this
          // transaction. A failure silently left a buyer's credits consumed against
          // a booking they were refunded for, with no actor to retry it. Rethrow
          // for the same reason the cascade above does: reverseCreditsForPayment is
          // re-entrant (the partial path nets against `restoredAmount`, the full
          // path deletes the usage row), so rolling back and re-driving is safe and
          // is strictly better than committing a partial refund.
          const restored = await reverseCreditsForPayment(
            paymentId,
            tx,
            refundAmt,
            originalPaymentAmt,
            refundRowId,
          );
          if (restored > 0) {
            console.log(
              `🔄 Reversed ${restored} referral credits for refunded payment ${paymentId}`,
            );
          }
        };

        if (existingRefund) {
          const newStatus = mapGatewayRefundStatus(status);
          if (existingRefund.status !== newStatus) {
            // Transition guard: PENDING is the only state a gateway event may
            // leave. SUCCEEDED / FAILED / CANCELLED are terminal here — a stale
            // or out-of-order delivery (e.g. `refund.created` with status
            // "pending" redelivered after `refund.processed`) must never
            // downgrade a settled refund into the unsweepable real-id-PENDING
            // limbo class, nor resurrect a failed one. (The old guard compared
            // the Prisma enum against the RAW gateway string, so it never
            // short-circuited and every redelivery rewrote the row.)
            if (existingRefund.status !== "PENDING") {
              console.log(
                `↩️ Refund ${refundId} already ${existingRefund.status}; ignoring ${status} event`,
              );
              return;
            }

            const claimed = await tx.refund.updateMany({
              where: { id: existingRefund.id, status: "PENDING" },
              data: {
                status: newStatus,
                updatedAt: new Date(),
              },
            });
            if (claimed.count === 0) return;
            console.log(`✅ Refund ${refundId} status updated to ${newStatus}`);

            // Run side effects when transitioning TO SUCCEEDED
            if (newStatus === "SUCCEEDED") {
              await runRefundSideEffects(
                payment.id,
                status,
                existingRefund.id,
                amount,
                payment.amount,
              );
              const notification = await notifyRefundProcessed(
                payment.userId,
                {
                  ...notificationScope(payment.organizationId),
                  amount,
                  currency,
                  dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
                },
                { tx, entityRef: `payment:${payment.id}` },
              );
              stagedNotification = notification?.staged ?? null;
              stagedEmails = await stageRefundProcessedEmail(tx, {
                userId: payment.userId,
                paymentId: payment.id,
                amountPaise: amount,
                currency,
              });
            }
          }
          return;
        }

        // PM-13 — a `refund.failed` for a refund we never recorded (e.g. a refund
        // initiated from the Razorpay dashboard, not our app) would otherwise mint
        // an orphan FAILED Refund row attached to the B2C payment. No money moves
        // either way on a failed refund, so there's nothing to record — skip it.
        const mappedNewStatus = mapGatewayRefundStatus(status);
        if (
          typeof notes?.reservationId === "string" &&
          notes.reservationId.length > 0 &&
          tx.refund.findFirst
        ) {
          const reservation = await tx.refund.findFirst({
            where: {
              id: notes.reservationId,
              paymentId: payment.id,
              amountPaise: amount,
              refundId: { startsWith: "pending_" },
            },
            select: { id: true, refundId: true },
          });
          if (reservation) {
            const claimed = await tx.refund.updateMany({
              where: {
                id: reservation.id,
                status: "PENDING",
                refundId: reservation.refundId,
              },
              data: {
                refundId,
                status: mappedNewStatus,
                updatedAt: new Date(),
              },
            });
            if (claimed.count > 0) {
              if (mappedNewStatus === "SUCCEEDED") {
                await runRefundSideEffects(
                  payment.id,
                  status,
                  reservation.id,
                  amount,
                  payment.amount,
                );
                const notification = await notifyRefundProcessed(
                  payment.userId,
                  {
                    ...notificationScope(payment.organizationId),
                    amount,
                    currency,
                    dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
                  },
                  { tx, entityRef: `payment:${payment.id}` },
                );
                stagedNotification = notification?.staged ?? null;
                stagedEmails = await stageRefundProcessedEmail(tx, {
                  userId: payment.userId,
                  paymentId: payment.id,
                  amountPaise: amount,
                  currency,
                });
              }
              return;
            }
            const rebound = await tx.refund.findUnique({
              where: { refundId },
              select: { id: true },
            });
            if (rebound) {
              return;
            }
          }
        }
        if (mappedNewStatus === "FAILED" && !existingRefund) {
          console.log(
            `↩️ Ignoring refund.failed for unknown refund ${refundId} (no existing row, no money movement)`,
          );
          return;
        }

        // Create new refund record
        const createdRefund = await tx.refund.create({
          data: {
            amountPaise: amount,
            // #781 §A — gateway hands back a free-form ISO code; an unsupported
            // one throws here and dead-letters the event rather than booking it.
            currency: toCurrencyEnum(currency),
            status: mappedNewStatus,
            refundId,
            paymentGateway: PaymentGateway.RAZORPAY,
            paymentId: payment.id,
          },
          select: { id: true },
        });

        console.log(`✅ Refund ${refundId} created for payment ${payment.id}`);

        // Run side effects for new refunds that are already SUCCEEDED
        await runRefundSideEffects(
          payment.id,
          status,
          createdRefund.id,
          amount,
          payment.amount,
        );

        if (mappedNewStatus === "SUCCEEDED") {
          // --- Novu notification (staged in the tx, attempted after commit) ---
          const notification = await notifyRefundProcessed(
            payment.userId,
            {
              // Payment.organizationId is the org tag (#PaymentOrgTag), so a refund
              // inherits the org-ness of the payment it reverses. dashboardUrl stays a
              // personal route deliberately: this goes to the PAYER, and an org billing
              // page is not readable by a LEARNER whose booking was org-sponsored.
              ...notificationScope(payment.organizationId),
              amount,
              currency,
              // #1527 — was a bare `/dashboard` router bounce; the recipient is
              // always the payer.
              dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
            },
            { tx, entityRef: `payment:${payment.id}` },
          );
          stagedNotification = notification?.staged ?? null;
          // #1653 — the email twin of the bell. Reads through `tx` only; the credit
          // note is minted inside the cascade and is not in scope here, so the
          // receipt omits its number rather than adding a query for it.
          stagedEmails = await stageRefundProcessedEmail(tx, {
            userId: payment.userId,
            paymentId: payment.id,
            amountPaise: amount,
            currency,
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  await refundMemberOverageSidePayment({
    parentPaymentId: overagePaymentId,
    due: overageDue,
    initiatedByUserId: null,
  });
  await attemptStaged(stagedNotification);
  await attemptStagedEmails(
    stagedEmails,
    MONEY_EMAIL_TYPES.REFUND_PROCESSED,
    EMAIL_BUDGET_MS.WEBHOOK,
  );
  return result;
}

// ============================================================================
// Dispute Webhook Handlers
// ============================================================================

/**
 * Handle dispute created event
 */
export async function handleDisputeCreated(
  disputeId: string,
  chargeId: string,
  amount: number,
  currency: string,
  reason: string,
  status: string,
  dueBy: number | null,
  isChargeRefundable: boolean,
) {
  const gateway = PaymentGateway.RAZORPAY;
  const razorpayClient = getRazorpayClient();
  let resolvedPaymentIntent: string | undefined;

  const existingLocalPayment = prisma.payment?.findFirst
    ? await prisma.payment.findFirst({
        where: { gatewayPaymentId: chargeId },
        select: { paymentIntent: true },
      })
    : null;
  if (existingLocalPayment?.paymentIntent) {
    resolvedPaymentIntent = existingLocalPayment.paymentIntent;
  } else if (razorpayClient) {
    try {
      const rzpPayment = await razorpayClient.payments.fetch(chargeId);
      if (rzpPayment.order_id) {
        resolvedPaymentIntent = rzpPayment.order_id;
      }
    } catch (error) {
      console.error(
        `Failed to fetch Razorpay payment ${chargeId} to link dispute:`,
        error,
      );
    }
  }

  let stagedNotification: StagedTrigger | null = null;
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const payment = await tx.payment.findFirst({
          where: {
            OR: [
              ...(resolvedPaymentIntent
                ? [{ paymentIntent: resolvedPaymentIntent }]
                : []),
              { gatewayPaymentId: chargeId },
            ],
          },
        });

        if (!payment) {
          console.warn(`Payment not found for dispute: ${disputeId}`);
          return new DeferSignal(`dispute_before_payment:${disputeId}`);
        }

        // Check if dispute already exists
        const existingDispute = await tx.dispute.findUnique({
          where: { disputeId },
        });

        if (existingDispute) {
          console.log(`Dispute ${disputeId} already exists`);
          return;
        }

        // Create dispute record. An unmapped gateway status falls back to the
        // protective NEEDS_RESPONSE hold — at creation the safe error is to
        // treat the dispute as live and hold earnings, never to drop it.
        const createdStatus = mapDisputeStatus(status);
        if (createdStatus === null) {
          console.warn(
            `Unknown dispute status "${status}" for ${disputeId} — defaulting to NEEDS_RESPONSE`,
          );
        }
        await tx.dispute.create({
          data: {
            amountPaise: amount,
            currency: toCurrencyEnum(currency),
            reason,
            status: createdStatus ?? "NEEDS_RESPONSE",
            disputeId,
            paymentGateway: gateway,
            dueBy: dueBy ? new Date(dueBy * 1000) : null,
            isChargeRefundable,
            paymentId: payment.id,
          },
        });

        console.log(
          `✅ Dispute ${disputeId} created for payment ${payment.id}`,
        );

        // M1 FIX: Hold consultant earnings to prevent payout of disputed funds.
        // #1020-1 — two CAS groups (not one blind updateMany) so each row's
        // PRIOR status rides along in preDisputeStatus: a WON/CLOSED release
        // must restore a PENDING earning to PENDING, not force-mature it. The
        // where-clauses exclude already-HELD rows, so a second dispute on the
        // same payment can never clobber the first hold's recorded prior.
        const heldReady = await tx.consultantEarnings.updateMany({
          where: { paymentId: payment.id, status: "READY" },
          data: { status: "HELD", preDisputeStatus: "READY" },
        });
        const heldPending = await tx.consultantEarnings.updateMany({
          where: { paymentId: payment.id, status: "PENDING" },
          data: { status: "HELD", preDisputeStatus: "PENDING" },
        });
        const heldPendingTrust = await tx.consultantEarnings.updateMany({
          where: { paymentId: payment.id, status: "PENDING_TRUST" },
          data: { status: "HELD", preDisputeStatus: "PENDING_TRUST" },
        });

        let heldBatchedCount = 0;
        if (tx.consultantEarnings.findMany) {
          const preflightBatched = await tx.consultantEarnings.findMany({
            where: {
              paymentId: payment.id,
              status: "BATCHED",
              payout: { status: { in: ["PENDING", "APPROVED"] } },
            },
            select: { id: true, payoutId: true },
          });
          if (preflightBatched.length > 0) {
            const batchedPayoutIds = [
              ...new Set(
                preflightBatched
                  .map((r) => r.payoutId)
                  .filter((id): id is string => Boolean(id)),
              ),
            ];
            const heldBatched = await tx.consultantEarnings.updateMany({
              where: {
                id: { in: preflightBatched.map((r) => r.id) },
                status: "BATCHED",
              },
              data: {
                status: "HELD",
                preDisputeStatus: "READY",
                payoutId: null,
              },
            });
            heldBatchedCount = heldBatched.count;
            if (batchedPayoutIds.length > 0) {
              await tx.consultantEarnings.updateMany({
                where: {
                  payoutId: { in: batchedPayoutIds },
                  status: "BATCHED",
                },
                data: { status: "READY", payoutId: null },
              });
              if (tx.consultantPayout?.updateMany) {
                await tx.consultantPayout.updateMany({
                  where: {
                    id: { in: batchedPayoutIds },
                    status: { in: ["PENDING", "APPROVED"] },
                  },
                  data: {
                    status: "CANCELLED",
                    failureReason: `Cancelled: linked payment entered dispute ${disputeId}`,
                  },
                });
                const cancelled = await tx.consultantPayout.findMany({
                  where: { id: { in: batchedPayoutIds }, status: "CANCELLED" },
                  select: { id: true },
                });
                for (const { id } of cancelled) {
                  await releaseClawbackRecovery(tx, id);
                }
              }
            }
          }
        }

        const heldResult = {
          count:
            heldReady.count +
            heldPending.count +
            heldPendingTrust.count +
            heldBatchedCount,
        };
        if (heldResult.count > 0) {
          console.log(
            `🔒 ${heldResult.count} earnings held due to dispute ${disputeId}`,
          );
        }

        // #1008 — hold the HOST org's earnings too (mirrors the consultant hold).
        const orgHeldReady = await tx.organizationEarnings.updateMany({
          where: { paymentId: payment.id, status: "READY" },
          data: { status: "HELD", preDisputeStatus: "READY" },
        });
        const orgHeldPending = await tx.organizationEarnings.updateMany({
          where: { paymentId: payment.id, status: "PENDING" },
          data: { status: "HELD", preDisputeStatus: "PENDING" },
        });
        const orgHeldPendingTrust = await tx.organizationEarnings.updateMany({
          where: { paymentId: payment.id, status: "PENDING_TRUST" },
          data: { status: "HELD", preDisputeStatus: "PENDING_TRUST" },
        });

        let orgHeldBatchedCount = 0;
        if (tx.organizationEarnings.findMany) {
          const preflightOrgBatched = await tx.organizationEarnings.findMany({
            where: {
              paymentId: payment.id,
              status: "BATCHED",
              orgPayout: { status: { in: ["PENDING", "APPROVED"] } },
            },
            select: { id: true, orgPayoutId: true },
          });
          if (preflightOrgBatched.length > 0) {
            const batchedOrgPayoutIds = [
              ...new Set(
                preflightOrgBatched
                  .map((r) => r.orgPayoutId)
                  .filter((id): id is string => Boolean(id)),
              ),
            ];
            const orgHeldBatched = await tx.organizationEarnings.updateMany({
              where: {
                id: { in: preflightOrgBatched.map((r) => r.id) },
                status: "BATCHED",
              },
              data: {
                status: "HELD",
                preDisputeStatus: "READY",
                orgPayoutId: null,
              },
            });
            orgHeldBatchedCount = orgHeldBatched.count;
            if (batchedOrgPayoutIds.length > 0) {
              await tx.organizationEarnings.updateMany({
                where: {
                  orgPayoutId: { in: batchedOrgPayoutIds },
                  status: "BATCHED",
                },
                data: { status: "READY", orgPayoutId: null },
              });
              if (tx.organizationPayout?.updateMany) {
                await tx.organizationPayout.updateMany({
                  where: {
                    id: { in: batchedOrgPayoutIds },
                    status: { in: ["PENDING", "APPROVED"] },
                  },
                  data: {
                    status: "CANCELLED",
                    failureReason: `Cancelled: linked payment entered dispute ${disputeId}`,
                  },
                });
                const cancelled = await tx.organizationPayout.findMany({
                  where: {
                    id: { in: batchedOrgPayoutIds },
                    status: "CANCELLED",
                  },
                  select: { id: true },
                });
                for (const { id } of cancelled) {
                  await releaseClawbackRecovery(tx, id);
                }
              }
            }
          }
        }

        const orgHeld = {
          count:
            orgHeldReady.count +
            orgHeldPending.count +
            orgHeldPendingTrust.count +
            orgHeldBatchedCount,
        };
        if (orgHeld.count > 0) {
          console.log(
            `🔒 ${orgHeld.count} org earnings held due to dispute ${disputeId}`,
          );
        }

        // --- Novu notification (staged in the tx, attempted after commit) ---
        const notifications = await notifyDisputeCreated(
          [payment.userId],
          {
            disputeId,
            amount,
            currency,
            reason,
            status: createdStatus ?? "NEEDS_RESPONSE",
            // #1527 — the recipient is always the payer.
            dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
          },
          { tx, entityRef: `dispute:${disputeId}` },
        );
        // Optional chaining: the barrel is stubbed to `undefined` in tests.
        stagedNotification = notifications?.[0]?.staged ?? null;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  await attemptStaged(stagedNotification);
  return result;
}

/**
 * Settle a LOST/CHARGE_REFUNDED dispute: the money half of a lost chargeback,
 * shared by the dispute webhook and the reconcile-disputes poll so a LOST
 * adopted by either path moves the same money exactly once.
 *
 * Idempotent: earnings flip out of HELD/PAID only (a re-run finds none), the
 * chargeback ledger posts are keyed `chargeback:<disputeId>`, and the credit
 * notes dedupe on the dispute. Returns the consultant clawback page for the
 * caller to dispatch post-commit — never paged from inside the tx.
 */
export interface LostDisputeSettlementInput {
  id: string;
  disputeId: string;
  amountPaise: number;
  paymentId: string;
  payment: {
    amount: number;
    organizationId?: string | null;
  };
}

export interface LostDisputeSettlement {
  consultantClawbackPage: {
    disputeId: string;
    paymentId: string;
    /** NET auto-booked as receivable — the figure an operator can collect. */
    amountPaise: number;
    /**
     * GROSS share reversed; exceeds `amountPaise` by withheld TDS, which is
     * reversed by `recordTdsReversal`, never collected.
     */
    grossReversedPaise: number;
    earnings: number;
    /** Ledger keys of the auto-clawbacks actually posted for this dispute. */
    clawbackKeys: string[];
  } | null;
}

export async function settleLostDispute(
  tx: Tx,
  dispute: LostDisputeSettlementInput,
): Promise<LostDisputeSettlement> {
  const { disputeId } = dispute;
  let consultantClawbackPage: LostDisputeSettlement["consultantClawbackPage"] =
    null;

  // Dispute lost — mark held earnings as REFUNDED, accounting for partial refunds.
  // #1020-3 — a PARTIAL dispute used to refund the FULL share on both
  // sides; every reversal here is now prorated to the disputed fraction
  // of the payment (floored, capped at the remaining refundable).
  // #1020-2 — the loops also include PAID rows: a fast payout followed
  // by a late chargeback used to leave paid-out earnings untouched.
  const prorationFactor =
    dispute.payment.amount > 0
      ? Math.min(dispute.amountPaise / dispute.payment.amount, 1)
      : 1;

  const lostConsultantEarnings = await tx.consultantEarnings.findMany({
    where: {
      paymentId: dispute.paymentId,
      status: { in: ["HELD", "BATCHED", "PENDING_TRUST", "PAID"] },
    },
    select: {
      id: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
      consultantProfileId: true,
      payoutId: true,
      status: true,
      // #R-06 — only a COMPLETED payout has cash to claw back; gross
      // `amount` + `tdsDeducted` scale the recovery to NET (W1a).
      payout: {
        select: {
          status: true,
          amount: true,
          tdsDeducted: true,
        },
      },
    },
  });
  let consultantManualRecoveryPaise = 0; // NET auto-booked (what we can actually collect)
  let consultantGrossReversedPaise = 0; // GROSS share reversed (earnings, not cash)
  let consultantManualRecoveryCount = 0;
  // Accumulated per payout and posted once after the loop: earnings
  // sharing a batch payout share one `clawback:<dispute>:<payout>` key.
  const consultantClawbacks = new Map<
    string,
    { consultantProfileId: string; amountPaise: number }
  >();
  const consultantClawbackKeys: string[] = [];
  for (const earning of lostConsultantEarnings) {
    const alreadyRefunded = earning.refundedShareAmount ?? 0;
    const remainingRefundable = Math.max(
      earning.consultantSharePaise - alreadyRefunded,
      0,
    );
    const proratedReversal = Math.floor(
      earning.consultantSharePaise * prorationFactor,
    );
    const reversalNow = Math.min(proratedReversal, remainingRefundable);

    // CAS: source status + pinned `refundedShareAmount`, absolute write.
    // Side effects below run only when this write landed.
    const { count: consultantReversalCount } =
      await tx.consultantEarnings.updateMany({
        where: {
          id: earning.id,
          status: { in: ["HELD", "BATCHED", "PENDING_TRUST", "PAID"] },
          refundedShareAmount: alreadyRefunded,
        },
        data: {
          status: "REFUNDED",
          preDisputeStatus: null,
          refundedShareAmount: alreadyRefunded + reversalNow,
        },
      });
    const consultantReversalApplied = consultantReversalCount === 1;

    // #738-B — statutory parity with the refund path: withholding that
    // was deposited against a now-charged-back sale must net out of the
    // next quarter's return. The shared helper's dedup cap prevents a
    // double reversal when an app refund preceded the chargeback.
    if (earning.payoutId && consultantReversalApplied) {
      await recordTdsReversal(tx, {
        payoutId: earning.payoutId,
        consultantProfileId: earning.consultantProfileId,
        earningsId: earning.id,
        refundAmountPaise: dispute.amountPaise,
        paymentAmountPaise: dispute.payment.amount,
      });
    }

    // A PAID share already left in a COMPLETED payout: book the NET
    // (amount - tdsDeducted) as a receivable; the withheld tax is
    // reversed separately by recordTdsReversal.
    const payoutGross = Number(earning.payout?.amount ?? 0);
    const payoutTds = Number(earning.payout?.tdsDeducted ?? 0);
    const netFraction =
      payoutGross > 0 ? Math.max(0, 1 - payoutTds / payoutGross) : 1;
    const netClawbackPaise = Math.floor(reversalNow * netFraction);

    if (earning.status === "PAID" && reversalNow > 0) {
      if (consultantReversalApplied) {
        consultantManualRecoveryPaise += netClawbackPaise;
        consultantGrossReversedPaise += reversalNow;
        consultantManualRecoveryCount++;
      } else {
        console.warn(
          `⚠️ Earnings ${earning.id}: dispute ${disputeId} LOST reversal lost the CAS (status or refundedShareAmount moved) — skipping the recovery page and clawback for this writer`,
        );
      }
      // Only a COMPLETED payout moved cash, and only the CAS winner claws back.
      // B2C only: on an org-funded payment the org already bore the
      // chargeback (applyOrgChargeback), so no consultant receivable.
      if (
        consultantReversalApplied &&
        !dispute.payment.organizationId &&
        earning.payoutId &&
        earning.payout?.status === "COMPLETED"
      ) {
        if (netClawbackPaise > 0) {
          const prior = consultantClawbacks.get(earning.payoutId);
          if (prior) {
            prior.amountPaise += netClawbackPaise;
          } else {
            consultantClawbacks.set(earning.payoutId, {
              consultantProfileId: earning.consultantProfileId,
              amountPaise: netClawbackPaise,
            });
          }
        }
      }
    }

    console.log(
      `💸 Earnings ${earning.id} refunded (${reversalNow} paise) — dispute ${disputeId} lost`,
    );
  }
  // One receivable per (dispute, payout).
  const clawbackRefundId = `dispute:${dispute.id}`;
  for (const [consultantPayoutId, claw] of consultantClawbacks) {
    const applied = await applyReversal(tx, {
      source: {
        kind: "CONSULTANT_CLAWBACK",
        consultantPayoutId,
        consultantProfileId: claw.consultantProfileId,
      },
      amountPaise: claw.amountPaise,
      reason: `chargeback lost (dispute ${disputeId})`,
      refundId: clawbackRefundId,
    });
    // Name only keys whose journal actually posted.
    if (applied.clawbackPosted) {
      consultantClawbackKeys.push(
        consultantClawbackKey(clawbackRefundId, consultantPayoutId),
      );
    }
  }

  if (consultantManualRecoveryCount > 0) {
    // Paged post-commit; names the earnings ops must collect.
    consultantClawbackPage = {
      disputeId,
      paymentId: dispute.paymentId,
      amountPaise: consultantManualRecoveryPaise,
      grossReversedPaise: consultantGrossReversedPaise,
      earnings: consultantManualRecoveryCount,
      clawbackKeys: consultantClawbackKeys,
    };
  }

  // #1008 — HOST org earnings side (mirrors the consultant loop above).
  // Held AND paid org earnings flip to REFUNDED; a share already paid out
  // to the host org is clawed back through the reversal engine. This is the
  // host-EARNINGS recovery — distinct from applyOrgChargeback below, which
  // recovers the sponsor-FUNDER's money (different party, no double-count).
  const lostOrgEarnings = await tx.organizationEarnings.findMany({
    where: {
      paymentId: dispute.paymentId,
      status: { in: ["HELD", "BATCHED", "PENDING_TRUST", "PAID"] },
    },
    select: {
      id: true,
      orgSharePaise: true,
      refundedAmountPaise: true,
      organizationId: true,
      orgPayoutId: true,
      status: true,
      orgPayout: { select: { status: true } },
    },
  });
  for (const oe of lostOrgEarnings) {
    const alreadyRefunded = oe.refundedAmountPaise ?? 0;
    const remaining = Math.max(oe.orgSharePaise - alreadyRefunded, 0);
    const requested = Math.min(
      Math.floor(oe.orgSharePaise * prorationFactor),
      remaining,
    );

    // #CASC — the shared CAS writer pins the prior amount and writes an
    // absolute value, so two LOST disputes compose to min(share, a + b).
    const orgApplied = (await applyCappedOrgEarningReversal(tx, oe, requested))
      .reversedPaise;

    // Terminalised here, not by the helper: a LOST dispute makes the row
    // terminal even when proration recovers less than the share. The
    // status predicate makes exactly one writer win.
    if (requested > 0) {
      await tx.organizationEarnings.updateMany({
        where: {
          id: oe.id,
          status: { in: ["HELD", "BATCHED", "PENDING_TRUST", "PAID"] },
        },
        data: { status: "REFUNDED", preDisputeStatus: null },
      });
    }

    // #1906 — the journal takes the APPLIED amount. Before, a capped or
    // lost-race reversal posted its full request, so the books recorded
    // a clawback larger than the share reduction it accompanied.
    if (
      oe.orgPayoutId &&
      oe.orgPayout?.status === "COMPLETED" &&
      orgApplied > 0
    ) {
      await applyReversal(tx, {
        source: {
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: oe.orgPayoutId,
          organizationId: oe.organizationId,
        },
        amountPaise: orgApplied,
        reason: `chargeback lost (dispute ${disputeId})`,
        refundId: `dispute:${dispute.id}`,
      });
    }
  }

  // #776 §C — org-funded chargeback money-path. When the disputed booking
  // was org-funded, the funder (the org) bears the chargeback, not the
  // platform: debit the org wallet, falling back to an ORG_RECEIVABLE the
  // dunning flow pursues if the wallet can't cover it.
  const disputedPayment = await tx.payment.findUnique({
    where: { id: dispute.paymentId },
    select: {
      id: true,
      organizationId: true,
      billingAccountId: true,
      amount: true,
      paymentIntent: true,
      appointmentId: true,
    },
  });
  if (disputedPayment?.organizationId) {
    await applyOrgChargeback(tx, {
      paymentId: disputedPayment.id,
      organizationId: disputedPayment.organizationId,
      billingAccountId: disputedPayment.billingAccountId,
      amountPaise: dispute.amountPaise,
      disputeId,
    });
  } else if (disputedPayment) {
    // #677 — B2C (non-org) booking: the org path above posts the REFUND
    // ledger leg via applyOrgChargeback; the B2C path historically posted
    // nothing, so a lost chargeback left the booking journal's CASH-in +
    // payable un-reversed (REVERSED_EARNING_WITHOUT_REFUND_TXN). Post the
    // symmetric reversal so the journal clears when the bank pulls the cash.
    await applyB2cChargebackReversal(tx, {
      paymentId: disputedPayment.id,
      disputeId,
      amountPaise: dispute.amountPaise,
      paymentAmountPaise: disputedPayment.amount,
    });
  }

  // #738-B — GST parity with the refund path: a lost chargeback reverses
  // the sale, so the issued invoice needs a Sec 34 credit note exactly
  // like a refund would. Idempotent on CreditNote.disputeId; no-op for
  // non-invoiced (B2C card) payments.
  await mintRefundCreditNote(tx, {
    paymentId: dispute.paymentId,
    disputeId: dispute.id,
    amountPaise: dispute.amountPaise,
    reason: `chargeback lost (dispute ${disputeId})`,
  });

  // Replay sales are the only appointment-less payments that grant playback.
  if (disputedPayment?.appointmentId === null) {
    await revokeReplayEntitlement(tx, disputedPayment.paymentIntent);
  }

  // #1365 — the B2C sibling. A personal buyer's tax invoice is reversed
  // by its own s.34 credit note on the platform series; idempotent on
  // ConsumerCreditNote.disputeId, and a no-op when no consumer invoice
  // was ever issued for the payment.
  await mintConsumerCreditNote(tx, {
    paymentId: dispute.paymentId,
    disputeId: dispute.id,
    amountPaise: dispute.amountPaise,
    reason: `chargeback lost (dispute ${disputeId})`,
  });

  return { consultantClawbackPage };
}

/**
 * Handle dispute updated event (status change, evidence submitted, etc.)
 */
const TERMINAL_DISPUTE_STATUSES: DisputeStatus[] = [
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
  "CLOSED",
  "WARNING_CLOSED",
];

async function releaseHeldEarningsOnDisputeWon(
  tx: Tx,
  paymentId: string,
  disputeRowId: string,
  disputeId: string,
): Promise<void> {
  const openSiblingDisputes = tx.dispute.count
    ? await tx.dispute.count({
        where: {
          paymentId,
          id: { not: disputeRowId },
          status: { notIn: TERMINAL_DISPUTE_STATUSES },
        },
      })
    : 0;
  if (openSiblingDisputes > 0) return;

  const relPending = await tx.consultantEarnings.updateMany({
    where: { paymentId, status: "HELD", preDisputeStatus: "PENDING" },
    data: { status: "PENDING", preDisputeStatus: null },
  });
  const relTrust = await tx.consultantEarnings.updateMany({
    where: { paymentId, status: "HELD", preDisputeStatus: "PENDING_TRUST" },
    data: { status: "PENDING_TRUST", preDisputeStatus: null },
  });
  const released = await tx.consultantEarnings.updateMany({
    where: { paymentId, status: "HELD" },
    data: { status: "READY", preDisputeStatus: null },
  });
  if (relPending.count + released.count + relTrust.count > 0) {
    console.log(
      `🔓 ${released.count} earnings released (+${relPending.count} restored to PENDING, +${relTrust.count} restored to PENDING_TRUST) — dispute ${disputeId} won`,
    );
  }

  const orgRelPending = await tx.organizationEarnings.updateMany({
    where: { paymentId, status: "HELD", preDisputeStatus: "PENDING" },
    data: { status: "PENDING", preDisputeStatus: null },
  });
  const orgRelTrust = await tx.organizationEarnings.updateMany({
    where: { paymentId, status: "HELD", preDisputeStatus: "PENDING_TRUST" },
    data: { status: "PENDING_TRUST", preDisputeStatus: null },
  });
  const orgReleased = await tx.organizationEarnings.updateMany({
    where: { paymentId, status: "HELD" },
    data: { status: "READY", preDisputeStatus: null },
  });
  if (orgReleased.count + orgRelPending.count + orgRelTrust.count > 0) {
    console.log(
      `🔓 ${orgReleased.count} org earnings released (+${orgRelPending.count} restored to PENDING, +${orgRelTrust.count} restored to PENDING_TRUST) — dispute ${disputeId} won`,
    );
  }
}

async function stageDisputeUpdatedNotification(
  tx: Tx,
  dispute: {
    paymentId: string;
    amountPaise: number;
    currency: string;
    reason: string | null;
  },
  priorStatus: DisputeStatus,
  mappedStatus: DisputeStatus,
  disputeId: string,
): Promise<StagedTrigger | null> {
  if (priorStatus === "UNDER_REVIEW" && mappedStatus === "NEEDS_RESPONSE") {
    const disputePayment = await tx.payment.findUnique({
      where: { id: dispute.paymentId },
    });
    if (!disputePayment) return null;
    const notifications = await notifyDisputeCreated(
      [disputePayment.userId],
      {
        disputeId,
        amount: dispute.amountPaise,
        currency: dispute.currency,
        reason: dispute.reason || "",
        status: mappedStatus,
        dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
      },
      { tx, entityRef: `dispute:${disputeId}:reopened` },
    );
    return notifications?.[0]?.staged ?? null;
  }

  if (TERMINAL_DISPUTE_STATUSES.includes(mappedStatus)) {
    const disputePayment = await tx.payment.findUnique({
      where: { id: dispute.paymentId },
    });
    if (!disputePayment) return null;
    const notifications = await notifyDisputeResolved(
      [disputePayment.userId],
      {
        disputeId,
        amount: dispute.amountPaise,
        currency: dispute.currency,
        reason: dispute.reason || undefined,
        status: mappedStatus,
        dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
      },
      { tx, entityRef: `dispute:${disputeId}` },
    );
    return notifications?.[0]?.staged ?? null;
  }

  return null;
}

export async function handleDisputeUpdated(
  disputeId: string,
  status: string,
  evidence: Prisma.InputJsonValue | null,
  respondBy?: number | null,
) {
  const txOutcome = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const dispute = await tx.dispute.findUnique({
          where: { disputeId },
          include: {
            payment: {
              select: {
                id: true,
                amount: true,
                organizationId: true,
              },
            },
          },
        });

        if (!dispute) {
          console.warn(`Dispute not found: ${disputeId}`);
          return {
            deferred: new DeferSignal("dispute_not_created_yet"),
            notification: null,
            clawbackPage: null,
          };
        }

        const mappedStatus = mapDisputeStatus(status);
        if (mappedStatus === null) {
          console.warn(
            `Unknown dispute status "${status}" for ${disputeId} — skipping update`,
          );
          return { notification: null, clawbackPage: null };
        }

        const priorStatus = dispute.status;
        if (
          priorStatus === mappedStatus ||
          !isLegalDisputeTransition(priorStatus, mappedStatus)
        ) {
          return { notification: null, clawbackPage: null };
        }

        const updateData = {
          status: mappedStatus,
          ...(respondBy ? { dueBy: new Date(respondBy * 1000) } : {}),
          ...(evidence ? { evidence } : {}),
          updatedAt: new Date(),
        };
        if (tx.dispute.updateMany) {
          const updated = await tx.dispute.updateMany({
            where: { id: dispute.id, status: priorStatus },
            data: updateData,
          });
          if (updated.count === 0) {
            return { notification: null, clawbackPage: null };
          }
        } else {
          await tx.dispute.update({
            where: { disputeId },
            data: updateData,
          });
        }

        let clawbackPage: LostDisputeSettlement["consultantClawbackPage"] =
          null;
        if (
          mappedStatus === "WON" ||
          mappedStatus === "WARNING_CLOSED" ||
          mappedStatus === "CLOSED"
        ) {
          await releaseHeldEarningsOnDisputeWon(
            tx,
            dispute.paymentId,
            dispute.id,
            disputeId,
          );
        } else if (
          mappedStatus === "LOST" ||
          mappedStatus === "CHARGE_REFUNDED"
        ) {
          const settlement = await settleLostDispute(tx, dispute);
          clawbackPage = settlement.consultantClawbackPage;
        }

        const notification = await stageDisputeUpdatedNotification(
          tx,
          dispute,
          priorStatus,
          mappedStatus,
          disputeId,
        );

        return { notification, clawbackPage };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );

  await attemptStaged(txOutcome.notification);

  if (txOutcome.clawbackPage) {
    const page = txOutcome.clawbackPage;
    void recordSystemErrorSafe({
      organizationId: null,
      category: "PAYOUT",
      summary: `Chargeback clawback needed: ${page.earnings} PAID consultant earning(s) on dispute ${page.disputeId} — ${page.amountPaise} paise auto-booked as receivable(s) ${page.clawbackKeys.join(", ") || "none — collect by hand"}. The gross share reversed is ${page.grossReversedPaise} paise; the receivable is NET of TDS because the transfer was net, so collect the NET figure and do not pursue the withheld tax (it is reversed separately by recordTdsReversal).`,
      err: new Error("CONSULTANT_PAID_EARNING_CLAWBACK"),
      context: { ...page },
    });
  }

  return txOutcome.deferred;
}

/**
 * #776 §C — settle a lost chargeback on an org-funded booking. The org funded
 * the booking, so the org bears the chargeback: debit its wallet. If the wallet
 * can't cover it (or there's no wallet), record the amount as an ORG_RECEIVABLE
 * the dunning flow pursues. Either way the platform's CASH (pulled by the bank)
 * is balanced by the org side. Idempotent on `chargeback:<disputeId>`.
 */
async function applyOrgChargeback(
  tx: Tx,
  params: {
    paymentId: string;
    organizationId: string;
    billingAccountId: string | null;
    amountPaise: number;
    disputeId: string;
  },
): Promise<void> {
  const { organizationId, billingAccountId, amountPaise, disputeId } = params;
  if (amountPaise <= 0) return;

  // Idempotent on the chargeback key. `walletDebit` is NOT keyed on the dispute,
  // but the ledger post below is — so a webhook retry would re-debit the wallet
  // while posting the ledger only once (drift + double-charge). If the
  // chargeback ledger txn already exists, this is a replay: skip all mutations.
  const alreadyPosted = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: `chargeback:${disputeId}` },
    select: { id: true },
  });
  if (alreadyPosted) return;

  const priorRefundAgg = await tx.refund.aggregate({
    where: {
      paymentId: params.paymentId,
      status: { in: ["SUCCEEDED"] },
    },
    _sum: { amountPaise: true },
  });
  const settlePaise = Math.max(
    0,
    amountPaise - sumPaise(priorRefundAgg._sum.amountPaise),
  );
  if (settlePaise <= 0) {
    console.log(
      `[Webhook] Chargeback ${disputeId} fully covered by prior refund(s) — no additional org debit`,
    );
    return;
  }

  let recoveredFromWallet = false;
  if (billingAccountId) {
    try {
      await walletDebit(tx, {
        billingAccountId,
        amountPaise: settlePaise,
        reason: "ADJUSTMENT",
        paymentId: params.paymentId,
        notes: `Chargeback recovery: dispute ${disputeId}`,
      });
      recoveredFromWallet = true;
    } catch (err) {
      if (!(err instanceof WalletInsufficientFundsError)) throw err;
      // Insufficient balance — fall through to the receivable path.
    }
  }

  // Balanced counter-post: the bank pulled CASH; recover it from the funder.
  await postLedgerTxn(tx, {
    idempotencyKey: `chargeback:${disputeId}`,
    kind: "REFUND",
    paymentId: params.paymentId,
    postings: [
      {
        account: recoveredFromWallet
          ? { kind: "WALLET", organizationId }
          : { kind: "ORG_RECEIVABLE", organizationId },
        direction: "DEBIT",
        amountPaise: settlePaise,
      },
      {
        account: { kind: "CASH" },
        direction: "CREDIT",
        amountPaise: settlePaise,
      },
    ],
  });

  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: null,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_REFUNDED,
      description: `Chargeback ${disputeId} settled: ${amountPaise} paise ${
        recoveredFromWallet ? "debited from wallet" : "booked as receivable"
      }`,
      details: {
        disputeId,
        paymentId: params.paymentId,
        amountPaise,
        recoveredFromWallet,
      } as Prisma.InputJsonValue,
    },
  });
}

export async function applyB2cChargebackReversal(
  tx: Tx,
  params: {
    paymentId: string;
    disputeId: string;
    amountPaise: number;
    paymentAmountPaise: number;
  },
): Promise<void> {
  const { paymentId, disputeId, amountPaise, paymentAmountPaise } = params;
  if (amountPaise <= 0 || paymentAmountPaise <= 0) return;

  // Idempotent: a webhook redelivery re-derives the same key and no-ops.
  const alreadyPosted = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: `chargeback:${disputeId}` },
    select: { id: true },
  });
  if (alreadyPosted) return;

  const priorRefundAgg = await tx.refund.aggregate({
    where: { paymentId, status: { in: ["SUCCEEDED"] } },
    _sum: { amountPaise: true },
  });
  const settlePaise = Math.max(
    0,
    amountPaise - sumPaise(priorRefundAgg._sum.amountPaise),
  );
  if (settlePaise <= 0) {
    console.log(
      `[Webhook] B2C chargeback ${disputeId} fully covered by prior refund(s) — no ledger reversal`,
    );
    return;
  }

  // Mirror the original booking journal. Reading the posted entries (rather than
  // recomputing the split) keeps the reversal correct for every funding mix.
  const booking = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: `booking:${paymentId}` },
    include: { entries: { include: { account: true } } },
  });
  if (!booking || booking.entries.length === 0) {
    await recordSystemErrorSafe({
      db: tx,
      organizationId: null,
      category: "LEDGER",
      summary: `B2C chargeback ${disputeId}: no booking ledger txn for payment ${paymentId} to reverse`,
      err: new Error("missing booking ledger txn"),
      context: { paymentId, disputeId },
    });
    return;
  }

  // Past the s.34(2) cutoff the GST stays with the government; PLATFORM_FEE absorbs it below.
  const supply = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { createdAt: true },
  });
  const gstStays = !!supply && isPastGstCreditNoteCutoff(supply.createdAt);

  // Proportional inverse: flip each leg's direction and floor-scale by the
  // settled fraction (== the whole booking for a full chargeback, no prior refund).
  const postings: Posting[] = booking.entries
    .filter((e) => !(gstStays && e.account.kind === "GST_PAYABLE"))
    .map((e): Posting => ({
      account: {
        kind: e.account.kind,
        organizationId: e.account.organizationId,
        consultantProfileId: e.account.consultantProfileId,
      },
      direction:
        e.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      // BigInt arithmetic (not Number*) so the proportional scale can't lose
      // precision on large paise values; BigInt division truncates toward zero
      // == Math.floor for these non-negative operands.
      amountPaise: Number(
        (BigInt(e.amountPaise) * BigInt(settlePaise)) /
          BigInt(paymentAmountPaise),
      ),
    }))
    .filter((p) => p.amountPaise > 0);

  // Balance the floor residual onto PLATFORM_FEE (the platform absorbs rounding,
  // mirroring refund.ts). residual === 0 for a full chargeback → exact negation.
  let debit = 0;
  let credit = 0;
  for (const p of postings) {
    if (p.direction === "DEBIT") debit += p.amountPaise;
    else credit += p.amountPaise;
  }
  const residual = debit - credit;
  if (residual !== 0) {
    postings.push({
      account: { kind: "PLATFORM_FEE" },
      direction: residual > 0 ? ("CREDIT" as const) : ("DEBIT" as const),
      amountPaise: Math.abs(residual),
    });
  }

  if (postings.length === 0) return;

  await postLedgerTxn(tx, {
    idempotencyKey: `chargeback:${disputeId}`,
    kind: "REFUND",
    paymentId,
    postings,
  });
}

// ============================================================================
// Webhook Event Logging
// ============================================================================

// ============================================================================
// Payout Webhook Handlers
// ============================================================================

/**
 * Handle RazorpayX payout webhook events.
 *
 * A1+A8 dispatcher: try the OrganizationPayout reconciler first (look up
 * by `gatewayPayoutId`). On hit, route to the org-payout state machine
 * (`markOrgPayoutCompleted` / `markOrgPayoutFailed` / `markOrgPayoutReversed`)
 * which already handles audit log + earnings release + Novu fire.
 *
 * On miss (no matching OrganizationPayout), fall through to the
 * consultant-payout path (`handlePayoutWebhook`). The consultant path
 * already soft-skips orphan IDs and returns 200 to prevent gateway
 * retry storms.
 *
 * Idempotency: the per-payout helpers themselves only progress rows in
 * the expected source state — duplicate webhook deliveries are a no-op.
 */
export async function handleRazorpayPayoutWebhook(
  eventType: string,
  payoutData: {
    id: string;
    status: string;
    failure_reason?: string;
    utr?: string;
    reference_id?: string;
  },
): Promise<void> {
  // First: is this an OrganizationPayout? Look up by gatewayPayoutId.
  // Imported lazily to avoid a circular import (org-payout-service ->
  // org-workflows -> ... -> webhooks/utils when it grows).
  const { default: prismaClient } = await import("@/lib/prisma");
  let orgPayout = await prismaClient.organizationPayout.findUnique({
    where: { gatewayPayoutId: payoutData.id },
    select: { id: true, status: true, organizationId: true },
  });

  if (!orgPayout && payoutData.reference_id) {
    const candidate = prismaClient.organizationPayout.findFirst
      ? await prismaClient.organizationPayout.findFirst({
          where: { id: payoutData.reference_id, gatewayPayoutId: null },
          select: { id: true, status: true, organizationId: true },
        })
      : await prismaClient.organizationPayout.findUnique({
          where: { id: payoutData.reference_id },
          select: { id: true, status: true, organizationId: true },
        });
    if (candidate) {
      if (prismaClient.organizationPayout.updateMany) {
        const bound = await prismaClient.organizationPayout.updateMany({
          where: { id: candidate.id, gatewayPayoutId: null },
          data: { gatewayPayoutId: payoutData.id },
        });
        if (bound.count > 0) {
          orgPayout = candidate;
        } else {
          orgPayout = await prismaClient.organizationPayout.findUnique({
            where: { gatewayPayoutId: payoutData.id },
            select: { id: true, status: true, organizationId: true },
          });
        }
      } else {
        await prismaClient.organizationPayout.update({
          where: { id: candidate.id },
          data: { gatewayPayoutId: payoutData.id },
        });
        orgPayout = candidate;
      }
    }
  }

  if (orgPayout) {
    const {
      markOrgPayoutCompleted,
      markOrgPayoutFailed,
      markOrgPayoutReversed,
    } = await import("@/lib/payments/payouts");

    switch (eventType) {
      case "payout.processed": {
        if (payoutData.utr) {
          await prismaClient.organizationPayout.update({
            where: { id: orgPayout.id },
            data: { gatewayUtr: payoutData.utr },
          });
        }
        await markOrgPayoutCompleted(orgPayout.id);
        break;
      }
      case "payout.cancelled": {
        await markOrgPayoutFailed(
          orgPayout.id,
          payoutData.failure_reason ?? "RazorpayX cancelled",
        );
        break;
      }
      case "payout.failed":
      case "payout.rejected": {
        await markOrgPayoutFailed(
          orgPayout.id,
          payoutData.failure_reason ?? "RazorpayX failure",
        );
        break;
      }
      case "payout.reversed": {
        await markOrgPayoutReversed(
          orgPayout.id,
          payoutData.failure_reason ?? "RazorpayX reversal",
        );
        break;
      }
      case "payout.updated": {
        if (payoutData.utr) {
          await prismaClient.organizationPayout.update({
            where: { id: orgPayout.id },
            data: { gatewayUtr: payoutData.utr },
          });
        }
        if (payoutData.status === "processed") {
          await markOrgPayoutCompleted(orgPayout.id);
        } else if (
          payoutData.status === "failed" ||
          payoutData.status === "rejected" ||
          payoutData.status === "cancelled"
        ) {
          await markOrgPayoutFailed(
            orgPayout.id,
            payoutData.failure_reason ?? `RazorpayX ${payoutData.status}`,
          );
        } else if (payoutData.status === "reversed") {
          await markOrgPayoutReversed(
            orgPayout.id,
            payoutData.failure_reason ?? "RazorpayX reversal",
          );
        }
        console.log(
          `[orgPayoutWebhook] payout.updated for ${orgPayout.id} (utr=${payoutData.utr ? "updated" : "unchanged"})`,
        );
        break;
      }
      default:
        console.log(
          `[orgPayoutWebhook] non-terminal event ${eventType} for ${orgPayout.id} — no-op`,
        );
    }
    console.log(
      `✅ Org payout ${orgPayout.id} (gateway=${payoutData.id}) webhook ${eventType} processed`,
    );
    return;
  }

  // Fall through to the consultant-payout path. Map RazorpayX status to
  // our internal enum.
  const statusMap: Record<
    string,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  > = {
    queued: "PENDING",
    pending: "PENDING",
    processing: "PROCESSING",
    processed: "COMPLETED",
    reversed: "FAILED",
    rejected: "FAILED",
    failed: "FAILED",
    cancelled: "CANCELLED",
  };

  const status = statusMap[payoutData.status];

  if (eventType === "payout.reversed") {
    const { markConsultantPayoutReversed } =
      await import("@/lib/payments/payouts");
    const { wasNoOp } = await markConsultantPayoutReversed(
      payoutData.id,
      payoutData.failure_reason ?? "RazorpayX reversal",
      payoutData.reference_id,
    );
    if (!wasNoOp) {
      console.log(
        `✅ RazorpayX consultant payout ${payoutData.id} reversed after completion`,
      );
      return;
    }
  }

  // R-5 — an unknown status keeps the payout as it is instead of downgrading it to PENDING.
  if (!status) {
    await reportUnknownPayoutStatus({
      provider: PaymentGateway.RAZORPAY,
      providerPayoutId: payoutData.id,
      status: payoutData.status,
      eventType,
    });
    return;
  }

  await handlePayoutWebhook(
    PaymentGateway.RAZORPAY,
    payoutData.id,
    status,
    payoutData.failure_reason,
    // UTR — forward the bank reference so a completing consultant payout
    // persists it, mirroring the org branch above.
    payoutData.utr,
    payoutData.reference_id,
  );

  console.log(
    `✅ RazorpayX consultant payout ${payoutData.id} webhook processed: ${status}`,
  );
}
