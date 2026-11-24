import type { Tx } from "@/lib/prisma";
import {
  refundNoticeKind,
  refundNoticeOverride,
} from "@/lib/payments/operations/refund-cause";
import prisma from "../../../lib/prisma";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { bookTopUpRefund } from "@/lib/payments/operations/wallet-refund";
import { prorate, sumPaise } from "@/lib/payments/utils/money";
import {
  isLegalDisputeTransition,
  isTerminalDisputeChange,
  mapDisputeStatus,
} from "@/lib/payments/dispute-status";
import {
  DisputeStatus,
  EarningStatus,
  EarningsHoldReason,
  PaymentGateway,
  Prisma,
} from "@prisma/client";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "@/lib/payments/core/razorpay";
import { handlePayoutWebhook } from "@/lib/payments/payouts";
import { reportUnknownPayoutStatus } from "@/lib/payments/payouts/payout-service";
import {
  applyCappedEarningReversal,
  applyCappedOrgEarningReversal,
} from "@/lib/payments/payouts/earning-reversal-cas";
import {
  HOLDABLE_EARNING_STATUSES,
  placeEarningsHolds,
  releaseEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";
import {
  notifyRefundProcessed,
  notifyDisputeCreated,
  notifyDisputeResolved,
  attemptTrigger,
  type StagedTrigger,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notifyOrgWalletTopupConfirmed } from "@/lib/novu/org-workflows";
import {
  sendOrgBillingEmail,
  stageDisputeNoticeEmail,
} from "@/lib/email/senders/money";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { voidVestedReferralRewards } from "@/lib/referrals/credit-reversal";
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
  remainingOrgInvoiceCreditPaise,
} from "@/lib/payments/operations/refund";
import { settleRefundSeatTx } from "@/lib/payments/operations/refund-seat";
import { mintConsumerCreditNote } from "@/lib/payments/billing/consumer-invoice";
import { invoiceRefundDebits } from "@/lib/payments/billing/org-invoice-journal";
import {
  applyOrgInvoiceCapture,
  attemptSettledInvoiceNotices,
} from "@/lib/payments/billing/org-invoice-settlement";
import { isPastGstCreditNoteCutoff } from "@/lib/compliance/gst-credit-note-cutoff";
import { cancelOpenPayoutsForPayment } from "@/lib/payments/payouts/cancel-open-payouts";
import { revokeStandaloneSaleEntitlement } from "@/lib/payments/digital-product-entitlement";
import {
  applyReversal,
  consultantClawbackKey,
} from "@/lib/payments/operations/reversal-engine";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  recordSystemErrorSafe,
  recordSystemEvent,
  recordSystemEventSafe,
} from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import {
  restoreOwedOnFailedRefund,
  resettleOwedOnLateSuccess,
  countOwedDriveFailure,
} from "@/lib/payments/operations/refund-owed";
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
              description: `Top-up amount mismatch: ${formatCurrencyAmount(paise, "INR")} expected, ${formatCurrencyAmount(gatewayAmountPaise, "INR")} charged`,
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
      const settledPaise = result.receivableSettledPaise ?? 0;
      const settledNote =
        settledPaise > 0
          ? `, ₹${(settledPaise / 100).toLocaleString("en-IN")} of it settled the org's open receivable`
          : "";
      const lateRefund = result.lateCaptureRefund;
      // The audit note is read by people: the reason is written in plain words, never as its code.
      const lateRefundWhy =
        lateRefund?.reason === "WALLET_FROZEN"
          ? "the wallet is frozen"
          : "the organisation is closed";
      const lateRefundNote = lateRefund
        ? `; late capture ${lateRefund.refundIssued ? "refunded to the card" : "owes a card refund"} because ${lateRefundWhy}`
        : "";
      if (organizationId && result.confirmed) {
        await prisma.orgAuditLog
          .create({
            data: {
              organizationId,
              actorMembershipId: null,
              category: "WALLET",
              action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP_CONFIRMED,
              description: `Top-up confirmed: ₹${(paise / 100).toLocaleString("en-IN")}${settledNote}${lateRefundNote}`,
              details: {
                walletEntryOrderId,
                providerPaymentId: razorpayPaymentId,
                amountPaise: paise,
                receivableSettledPaise: settledPaise,
                lateCaptureRefund: lateRefund ?? null,
              },
            },
          })
          .catch((err) =>
            console.error(
              "[Webhook] Failed to write WALLET_TOPUP_CONFIRMED audit log:",
              err,
            ),
          );
      }
      // A late capture sent back to the card is no top-up the owners should be told about.
      if (organizationId && result.confirmed && !lateRefund) {
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
          const dashboardUrl = `${getAppUrl()}/dashboard/organization/${organizationId}/billing`;
          const currency = orgRow.billingAccount?.currency ?? "INR";
          const newBalancePaise = orgRow.billingAccount?.walletBalance ?? 0;
          const owners =
            (await prisma.membership?.findMany({
              where: { organizationId, status: "ACTIVE", role: "OWNER" },
              select: { userId: true },
            })) ?? [];
          await Promise.allSettled([
            notifyOrgWalletTopupConfirmed(organizationId, {
              orgName: orgRow.name,
              amountPaise: paise,
              currency,
              newBalancePaise,
              dashboardUrl,
            }),
            ...(owners.length > 0 &&
            typeof prisma.user?.findMany === "function" &&
            typeof prisma.failedEmail?.create === "function"
              ? [
                  sendOrgBillingEmail(
                    {
                      recipientUserIds: owners.map((o) => o.userId),
                      organizationId,
                      orgName: orgRow.name,
                      kind: "WALLET_TOPUP_CONFIRMED",
                      amountPaise: paise,
                      currency,
                      newBalancePaise,
                      receivableSettledPaise: settledPaise,
                      dashboardUrl,
                    },
                    EMAIL_BUDGET_MS.WEBHOOK,
                  ),
                ]
              : []),
          ]);
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
    // No ISSUED→PAID without the captured amount and its payment id; the
    // payment.captured delivery carries both.
    if (gatewayAmountPaise === undefined || !razorpayPaymentId) {
      console.log(
        `[Webhook] invoice_payment ${invoiceId} deferred: no gateway amount (awaiting payment.captured)`,
      );
      return;
    }
    // Delivery is at-least-once: a throw rolls back and Razorpay retries.
    const outcome = await prisma.$transaction((tx) =>
      applyOrgInvoiceCapture(tx, {
        invoiceId,
        gatewayPaymentId: razorpayPaymentId,
        capturedPaise: gatewayAmountPaise,
        notesOrganizationId: organizationId ?? null,
      }),
    );
    if (outcome.kind !== "PAID") {
      console.log(`[Webhook] invoice_payment ${invoiceId}: ${outcome.kind}`);
      return;
    }
    const { settled } = outcome;
    console.log(`[Webhook] Invoice paid: ${invoiceId}`);
    await prisma.orgAuditLog
      .create({
        data: {
          organizationId: settled.organizationId,
          actorMembershipId: null,
          category: "INVOICE",
          action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
          description: `Invoice ${settled.invoiceNumber} paid via webhook`,
          details: { invoiceId, providerPaymentId: razorpayPaymentId },
        },
      })
      .catch((err) =>
        console.error("[Webhook] Failed to write INVOICE_PAID audit log:", err),
      );
    await attemptSettledInvoiceNotices(settled);
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
    const pendingTopUp = await prisma.walletTopUp.findFirst({
      where: {
        providerOrderId: walletEntryOrderId,
        status: "PENDING",
        providerPaymentId: null,
      },
      select: { id: true },
    });
    console.log(
      `[Webhook] credit_purchase.failed recorded (pendingPreserved=${Boolean(pendingTopUp)}) order=${walletEntryOrderId}`,
    );
    if (organizationId && pendingTopUp) {
      await prisma.orgAuditLog
        .create({
          data: {
            organizationId,
            actorMembershipId: null,
            category: "WALLET",
            action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP,
            description: "Top-up failed at gateway",
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
    // A failed attempt leaves its order retryable and must not hide a later capture.
    console.log(
      `[Webhook] invoice_payment.failed retained provider order id for invoice ${invoiceId}`,
    );
    if (organizationId) {
      await prisma.orgAuditLog
        .create({
          data: {
            organizationId,
            actorMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
            description: "Invoice payment failed at gateway",
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
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        stagedEmails = [];
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

        if (payment?.paymentStatus === "PENDING") {
          return new DeferSignal(`refund_before_capture:${refundId}`);
        }

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
              // The refund-remaining door books the same key first when it issued this refund.
              const booked = await bookTopUpRefund(tx, {
                topUp,
                refundId,
                amountPaise: amount,
              });
              if (!booked.booked) {
                console.log(
                  `💸 Top-up refund already booked for payment ${providerPaymentId}, skipping`,
                );
                return;
              }
              const shortfallNote =
                booked.shortfallPaise > 0
                  ? `; ${booked.shortfallPaise} paise booked as ORG_RECEIVABLE`
                  : "";
              console.log(
                `💸 Top-up refund ${refundId} booked: -${booked.clawbackPaise} paise on billingAccount ${topUp.billingAccountId}${shortfallNote}`,
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
                    description: `Invoice ${invoice.invoiceNumber} refunded (${formatCurrencyAmount(amount, currency)})`,
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
              // value went: back to GATEWAY_CLEARING when the gateway returns the money, or
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
                        account: gatewayCashAccount(),
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
            await applyRefundCascade(tx, {
              paymentId,
              refundId: refundRowId,
              amountPaise: refundAmt ?? originalPaymentAmt ?? 0,
              reason: "Gateway refund",
              initiatedByUserId: null,
            });
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
          // The booking seat is decided once, here, as the refund settles; the revocation sweep drives Stream.
          await settleRefundSeatTx(tx, refundRowId);
        };

        if (existingRefund) {
          const newStatus = mapGatewayRefundStatus(status);
          if (existingRefund.status !== newStatus) {
            // Transition guard: PENDING is the only state a gateway event may
            // leave. SUCCEEDED / FAILED / CANCELLED are terminal here — a stale
            // or out-of-order delivery (e.g. `refund.created` with status
            // "pending" redelivered after `refund.processed`) must never
            // downgrade a settled refund into the unsweepable real-id-PENDING
            // limbo class. A late success on a locally FAILED row is the one
            // exception: the money left, so it settles and cascades once (`cascadedAt`).
            const lateSuccess =
              existingRefund.status === "FAILED" && newStatus === "SUCCEEDED";
            if (existingRefund.status !== "PENDING" && !lateSuccess) {
              console.log(
                `↩️ Refund ${refundId} already ${existingRefund.status}; ignoring ${status} event`,
              );
              return;
            }

            const claimed = await tx.refund.updateMany({
              where: { id: existingRefund.id, status: existingRefund.status },
              data: {
                status: newStatus,
                updatedAt: new Date(),
              },
            });
            if (claimed.count === 0) return;
            console.log(`✅ Refund ${refundId} status updated to ${newStatus}`);
            // A failed hand refund gives back the owed refund it settled; a late success takes it off again.
            if (newStatus === "FAILED") {
              await restoreOwedOnFailedRefund(tx, existingRefund.id);
              await countOwedDriveFailure(tx, existingRefund.id);
            }
            if (lateSuccess) {
              await resettleOwedOnLateSuccess(tx, existingRefund.id);
            }

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
                {
                  tx,
                  entityRef: `payment:${payment.id}`,
                  required: refundNoticeOverride(
                    existingRefund.reason,
                    payment.userId,
                  ),
                },
              );
              stagedNotification = notification?.staged ?? null;
              stagedEmails = await stageRefundProcessedEmail(tx, {
                userId: payment.userId,
                paymentId: payment.id,
                amountPaise: amount,
                currency,
                required: refundNoticeKind(existingRefund.reason) !== null,
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
            select: { id: true, refundId: true, reason: true, status: true },
          });
          if (reservation) {
            // A success for a placeholder already marked FAILED moved the money
            // after all: it claims that row rather than booking a second one.
            const lateSuccess =
              reservation.status === "FAILED" &&
              mappedNewStatus === "SUCCEEDED";
            const claimed = await tx.refund.updateMany({
              where: {
                id: reservation.id,
                status: lateSuccess ? "FAILED" : "PENDING",
                refundId: reservation.refundId,
              },
              data: {
                refundId,
                status: mappedNewStatus,
                updatedAt: new Date(),
              },
            });
            if (claimed.count > 0) {
              if (mappedNewStatus === "FAILED") {
                await restoreOwedOnFailedRefund(tx, reservation.id);
                await countOwedDriveFailure(tx, reservation.id);
              }
              if (lateSuccess) {
                await resettleOwedOnLateSuccess(tx, reservation.id);
              }
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
                  {
                    tx,
                    entityRef: `payment:${payment.id}`,
                    required: refundNoticeOverride(
                      reservation.reason,
                      payment.userId,
                    ),
                  },
                );
                stagedNotification = notification?.staged ?? null;
                stagedEmails = await stageRefundProcessedEmail(tx, {
                  userId: payment.userId,
                  paymentId: payment.id,
                  amountPaise: amount,
                  currency,
                  required: refundNoticeKind(reservation.reason) !== null,
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

const DISPUTE_HOLDABLE: EarningStatus[] = [
  ...HOLDABLE_EARNING_STATUSES,
  EarningStatus.HELD,
];

/**
 * Freezes the payment's unpaid earnings under this dispute's own hold. A share
 * batched into a payout not yet sent is pulled out first: that payout is
 * cancelled and its other earnings return to READY.
 */
async function placeDisputeHolds(
  tx: Tx,
  paymentId: string,
  disputeRowId: string,
  disputeId: string,
): Promise<{ consultant: number; org: number }> {
  await cancelOpenPayoutsForPayment(
    tx,
    paymentId,
    `Cancelled: linked payment entered dispute ${disputeId}`,
  );

  const hold = { reason: EarningsHoldReason.DISPUTE, sourceRef: disputeRowId };
  const consultantIds = (
    await tx.consultantEarnings.findMany({
      where: { paymentId, status: { in: DISPUTE_HOLDABLE } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const orgIds = (
    await tx.organizationEarnings.findMany({
      where: { paymentId, status: { in: DISPUTE_HOLDABLE } },
      select: { id: true },
    })
  ).map((r) => r.id);
  const consultant = await placeEarningsHolds(
    tx,
    "consultant",
    consultantIds,
    hold,
  );
  const org = await placeEarningsHolds(tx, "org", orgIds, hold);
  return { consultant: consultant.length, org: org.length };
}

/** A dispute event the handlers did not adopt; their transaction returns it and changes nothing. */
interface UnadoptedDisputeEvent {
  severity: "ERROR" | "WARN";
  dispute: {
    id: string;
    disputeId: string;
    paymentId: string;
    status: DisputeStatus;
  };
  incomingStatus: string;
  phase: string | null;
}

/**
 * Records an unadopted dispute event after its transaction commits, once per
 * webhook delivery: a stuck-event re-drive of the same delivery adds nothing.
 * Strict, so a failed insert fails the delivery and the re-drive records it.
 */
async function recordUnadoptedDisputeEvent(
  event: UnadoptedDisputeEvent,
  webhookEventId: string | null,
): Promise<void> {
  const { dispute, incomingStatus, phase } = event;
  const correlationId = webhookEventId ?? `dispute:${dispute.disputeId}`;
  if (webhookEventId) {
    const recorded = await prisma.systemEvent.findFirst({
      where: { category: "razorpay_webhook", correlationId },
      select: { id: true },
    });
    if (recorded) return;
  }
  const inPhase = phase ? ` in phase ${phase}` : "";
  await recordSystemEvent({
    strict: true,
    category: "razorpay_webhook",
    severity: event.severity,
    message: `Dispute ${dispute.disputeId} is ${dispute.status} but the gateway sent "${incomingStatus}"${inPhase}; its status and money were left unchanged`,
    context: {
      disputeId: dispute.disputeId,
      paymentId: dispute.paymentId,
      disputeRowId: dispute.id,
      storedStatus: dispute.status,
      incomingStatus,
      phase,
    },
    correlationId,
  });
}

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
  options?: {
    isRedrive?: boolean;
    phase?: string | null;
    webhookEventId?: string | null;
  },
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
      const rzpPayment = await withRazorpaySdkTimeout("payments.fetch", () =>
        razorpayClient.payments.fetch(chargeId),
      );
      if (rzpPayment.order_id) {
        resolvedPaymentIntent = rzpPayment.order_id;
      }
    } catch (error) {
      console.error(
        `Failed to fetch Razorpay payment ${chargeId} to link dispute:`,
        error,
      );
      if (!options?.isRedrive) {
        await recordSystemErrorSafe({
          category: "razorpay_webhook",
          summary: `CRITICAL_DISPUTE_UNLINKED: failed to fetch Razorpay payment ${chargeId} for dispute ${disputeId}`,
          err: error,
          context: { disputeId, chargeId, amount },
        });
      }
    }
  }

  let stagedNotification: StagedTrigger | null = null;
  let stagedDisputeEmails: StagedRecipientEmail[] = [];
  let unadopted: UnadoptedDisputeEvent | null = null;
  const result = await withSerializableRetry(() => {
    stagedNotification = null;
    stagedDisputeEmails = [];
    unadopted = null;
    return prisma.$transaction(
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

        if (!payment || payment.paymentStatus === "PENDING") {
          console.warn(
            `Payment not yet captured for dispute: ${disputeId} (status=${payment?.paymentStatus ?? "missing"})`,
          );
          return new DeferSignal(`dispute_before_payment:${disputeId}`);
        }

        // Check if dispute already exists
        const existingDispute = await tx.dispute.findUnique({
          where: { disputeId },
        });

        if (existingDispute) {
          const phase = options?.phase ?? null;
          if (
            isTerminalDisputeChange(
              existingDispute.status,
              mapDisputeStatus(status),
              phase,
            )
          ) {
            unadopted = {
              severity: "ERROR",
              dispute: existingDispute,
              incomingStatus: status,
              phase,
            };
          } else {
            console.log(`Dispute ${disputeId} already exists`);
          }
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
        const created = await tx.dispute.create({
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

        const held = await placeDisputeHolds(
          tx,
          payment.id,
          created.id,
          disputeId,
        );
        if (held.consultant + held.org > 0) {
          console.log(
            `🔒 ${held.consultant} earnings and ${held.org} org earnings held due to dispute ${disputeId}`,
          );
        }

        const dashboardUrl = `${getAppUrl()}${goHref("client", "payments")}`;
        const notifications = await notifyDisputeCreated(
          [payment.userId],
          {
            disputeId,
            amount,
            currency,
            reason,
            status: createdStatus ?? "NEEDS_RESPONSE",
            dashboardUrl,
          },
          { tx, entityRef: `dispute:${disputeId}` },
        );
        stagedNotification = notifications?.[0]?.staged ?? null;
        if (
          typeof tx.user?.findMany === "function" &&
          typeof tx.failedEmail?.create === "function"
        ) {
          stagedDisputeEmails = await stageDisputeNoticeEmail(tx, {
            userId: payment.userId,
            disputeId,
            paymentId: payment.id,
            kind: "OPENED",
            amountPaise: amount,
            currency,
            reason,
            respondBy: dueBy ? new Date(dueBy * 1000) : null,
            dashboardUrl,
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    );
  });
  if (unadopted) {
    await recordUnadoptedDisputeEvent(
      unadopted,
      options?.webhookEventId ?? null,
    );
  }
  if (result instanceof DeferSignal && !options?.isRedrive) {
    await recordSystemErrorSafe({
      category: "razorpay_webhook",
      summary: `CRITICAL_DISPUTE_UNLINKED: no Payment matched dispute ${disputeId} (${chargeId})`,
      err: new Error("Payment not found for dispute"),
      context: { disputeId, chargeId, amount },
    });
  }
  await Promise.allSettled([
    attemptStaged(stagedNotification),
    attemptStagedEmails(
      stagedDisputeEmails,
      MONEY_EMAIL_TYPES.DISPUTE_NOTICE,
      EMAIL_BUDGET_MS.WEBHOOK,
    ),
  ]);
  return result;
}

/** The dispute a settlement acts on: the row id keys its holds and receivables. */
export interface DisputeSettlementInput {
  id: string;
  disputeId: string;
  amountPaise: number;
  paymentId: string;
  payment: { amount: number };
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

const NO_CLAWBACK_PAGE: LostDisputeSettlement = {
  consultantClawbackPage: null,
};

/** Rows a lost chargeback reverses; PENDING/READY rows were frozen into HELD at creation. */
const LOST_REVERSIBLE: EarningStatus[] = [
  EarningStatus.HELD,
  EarningStatus.BATCHED,
  EarningStatus.PENDING_TRUST,
  EarningStatus.PAID,
];

/** Legs that mean an organisation, not a card, funded the payment. */
const ORG_RAIL_LEG_SOURCES = ["WALLET", "INVOICE_ACCRUAL", "LICENSE"] as const;

async function releaseDisputeHolds(
  tx: Tx,
  dispute: DisputeSettlementInput,
): Promise<void> {
  const match = {
    reasons: [EarningsHoldReason.DISPUTE],
    sourceRef: dispute.id,
  };
  const consultantIds = (
    await tx.consultantEarnings.findMany({
      where: { paymentId: dispute.paymentId },
      select: { id: true },
    })
  ).map((r) => r.id);
  const orgIds = (
    await tx.organizationEarnings.findMany({
      where: { paymentId: dispute.paymentId },
      select: { id: true },
    })
  ).map((r) => r.id);
  const consultant = await releaseEarningsHolds(
    tx,
    "consultant",
    consultantIds,
    match,
  );
  const org = await releaseEarningsHolds(tx, "org", orgIds, match);
  if (consultant.released.length + org.released.length > 0) {
    console.log(
      `🔓 dispute ${dispute.disputeId} released its holds on ${consultant.released.length} earnings and ${org.released.length} org earnings (${consultant.restored.size + org.restored.size} left HELD)`,
    );
  }
}

/** WON, or a closed early-fraud warning: the money stays, so release this dispute's holds. */
export async function settleWonDispute(
  tx: Tx,
  dispute: DisputeSettlementInput,
): Promise<LostDisputeSettlement> {
  await releaseDisputeHolds(tx, dispute);
  return NO_CLAWBACK_PAGE;
}

/**
 * LOST / CHARGE_REFUNDED: settle on the lost amount, never above the disputed
 * amount, reversing that fraction of `payment.amount` from every share on
 * integers, then release this dispute's hold, so a partial loss leaves the rest
 * payable. A share goes REFUNDED only once its whole amount is reversed.
 * Callers run it once, on the CAS that moves the dispute to its verdict.
 */
export async function settleLostDispute(
  tx: Tx,
  dispute: DisputeSettlementInput,
  lostAmountPaise: number,
): Promise<LostDisputeSettlement> {
  const { disputeId } = dispute;
  const lostPaise = Math.min(Math.max(0, lostAmountPaise), dispute.amountPaise);
  if (lostPaise <= 0) {
    await releaseDisputeHolds(tx, dispute);
    return NO_CLAWBACK_PAGE;
  }
  let consultantClawbackPage: LostDisputeSettlement["consultantClawbackPage"] =
    null;

  const orgFunded =
    (await tx.paymentLeg.count({
      where: {
        paymentId: dispute.paymentId,
        source: { in: [...ORG_RAIL_LEG_SOURCES] },
      },
    })) > 0;

  // Floored per share on integers; a loss of the whole payment takes the whole share.
  const lostShareOf = (sharePaise: number): number =>
    dispute.payment.amount > 0
      ? prorate(
          sharePaise,
          Math.min(lostPaise, dispute.payment.amount),
          dispute.payment.amount,
        )
      : sharePaise;

  const lostConsultantEarnings = await tx.consultantEarnings.findMany({
    where: {
      paymentId: dispute.paymentId,
      status: { in: LOST_REVERSIBLE },
    },
    select: {
      id: true,
      consultantSharePaise: true,
      refundedShareAmount: true,
      consultantProfileId: true,
      payoutId: true,
      status: true,
      // Only a COMPLETED payout has cash to claw back; gross `amount` and
      // `tdsDeducted` scale the recovery to NET.
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
    const { reversedPaise: reversalNow } = await applyCappedEarningReversal(
      tx,
      earning,
      lostShareOf(earning.consultantSharePaise),
      LOST_REVERSIBLE,
    );
    const consultantReversalApplied = reversalNow > 0;

    // Withholding deposited against a charged-back sale nets out of the next
    // return; the helper's dedup cap stops a double reversal after a refund.
    if (earning.payoutId && consultantReversalApplied) {
      await recordTdsReversal(tx, {
        payoutId: earning.payoutId,
        consultantProfileId: earning.consultantProfileId,
        earningsId: earning.id,
        refundAmountPaise: lostPaise,
        paymentAmountPaise: dispute.payment.amount,
      });
    }

    // A PAID share already left in a COMPLETED payout: book the NET
    // (amount - tdsDeducted) as a receivable; the withheld tax is
    // reversed separately by recordTdsReversal.
    const payoutGross = Number(earning.payout?.amount ?? 0);
    const payoutTds = Number(earning.payout?.tdsDeducted ?? 0);
    const netClawbackPaise =
      payoutGross > 0
        ? prorate(
            reversalNow,
            Math.max(0, payoutGross - payoutTds),
            payoutGross,
          )
        : reversalNow;

    if (earning.status === "PAID" && consultantReversalApplied) {
      consultantManualRecoveryPaise += netClawbackPaise;
      consultantGrossReversedPaise += reversalNow;
      consultantManualRecoveryCount++;
      // Only a COMPLETED payout moved cash. An org-rail payment's funder bore
      // the chargeback (applyOrgChargeback), so no consultant receivable.
      if (
        !orgFunded &&
        earning.payoutId &&
        earning.payout?.status === "COMPLETED" &&
        netClawbackPaise > 0
      ) {
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

    console.log(
      `💸 Earnings ${earning.id} reversed ${reversalNow} paise — dispute ${disputeId} lost`,
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

  // The HOST org's earnings, mirroring the consultant loop. Distinct from
  // applyOrgChargeback below, which recovers the sponsor-FUNDER's money.
  const lostOrgEarnings = await tx.organizationEarnings.findMany({
    where: {
      paymentId: dispute.paymentId,
      status: { in: LOST_REVERSIBLE },
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
    // The shared CAS writer pins the prior amount and writes an absolute
    // value, so two LOST disputes compose to min(share, a + b).
    const orgApplied = (
      await applyCappedOrgEarningReversal(tx, oe, lostShareOf(oe.orgSharePaise))
    ).reversedPaise;

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
          orgEarningsId: oe.id,
        },
        amountPaise: orgApplied,
        reason: `chargeback lost (dispute ${disputeId})`,
        refundId: `dispute:${dispute.id}`,
      });
    }
  }

  await releaseDisputeHolds(tx, dispute);

  // An org-rail payment's funder bears the chargeback: debit its wallet, or
  // book an ORG_RECEIVABLE. A card payment, org-tagged or not, reverses the
  // booking journal like any B2C sale.
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
  if (orgFunded && disputedPayment?.organizationId) {
    await applyOrgChargeback(tx, {
      paymentId: disputedPayment.id,
      organizationId: disputedPayment.organizationId,
      billingAccountId: disputedPayment.billingAccountId,
      amountPaise: lostPaise,
      disputeId,
    });
  } else if (disputedPayment) {
    await applyB2cChargebackReversal(tx, {
      paymentId: disputedPayment.id,
      disputeId,
      amountPaise: lostPaise,
      paymentAmountPaise: disputedPayment.amount,
    });
  }

  // A lost chargeback reverses the sale: a s.34 credit note, idempotent on
  // CreditNote.disputeId; a no-op for a payment with no org invoice.
  await mintRefundCreditNote(tx, {
    paymentId: dispute.paymentId,
    disputeId: dispute.id,
    amountPaise: lostPaise,
    reason: `chargeback lost (dispute ${disputeId})`,
  });

  // A lost chargeback on a standalone sale revokes the entitlement it granted.
  if (disputedPayment?.appointmentId === null) {
    await revokeStandaloneSaleEntitlement(tx, disputedPayment);
  }

  // A referral this payment vested loses the reward it has not spent yet.
  await voidVestedReferralRewards(tx, {
    paymentId: dispute.paymentId,
    disputeId,
    now: new Date(),
  });

  // The consumer invoice's own s.34 credit note; idempotent on
  // ConsumerCreditNote.disputeId, a no-op when none was issued.
  await mintConsumerCreditNote(tx, {
    paymentId: dispute.paymentId,
    disputeId: dispute.id,
    amountPaise: lostPaise,
    reason: `chargeback lost (dispute ${disputeId})`,
  });

  return { consultantClawbackPage };
}

/** Razorpay `closed`: a loss for whatever it deducted, else a release. */
export async function settleClosedDispute(
  tx: Tx,
  dispute: DisputeSettlementInput,
  amountDeductedPaise: number | null,
): Promise<LostDisputeSettlement> {
  return amountDeductedPaise && amountDeductedPaise > 0
    ? settleLostDispute(tx, dispute, amountDeductedPaise)
    : settleWonDispute(tx, dispute);
}

/** A reported deduction other than the disputed amount, recorded once the settlement commits. */
export interface DeductionMismatch {
  disputeId: string;
  paymentId: string;
  disputeRowId: string;
  verdict: DisputeStatus;
  reportedDeductedPaise: number;
  disputedPaise: number;
  settledPaise: number;
}

export interface DisputeVerdictSettlement extends LostDisputeSettlement {
  deductionMismatch: DeductionMismatch | null;
}

/**
 * A lost verdict settles on the reported deduction when it is above 0, capped
 * at the disputed amount; a 0 or missing figure is unknown, so the disputed
 * amount is used.
 */
function lostDisputeAmount(
  dispute: DisputeSettlementInput,
  verdict: DisputeStatus,
  reportedPaise: number | null,
): { settledPaise: number; mismatch: DeductionMismatch | null } {
  const settledPaise =
    reportedPaise !== null && reportedPaise > 0
      ? Math.min(reportedPaise, dispute.amountPaise)
      : dispute.amountPaise;
  const mismatch =
    reportedPaise !== null && reportedPaise !== dispute.amountPaise
      ? {
          disputeId: dispute.disputeId,
          paymentId: dispute.paymentId,
          disputeRowId: dispute.id,
          verdict,
          reportedDeductedPaise: reportedPaise,
          disputedPaise: dispute.amountPaise,
          settledPaise,
        }
      : null;
  return { settledPaise, mismatch };
}

/** Callers run it after the settlement's transaction commits, so it is written once per settlement. */
export async function recordDeductionMismatch(
  mismatch: DeductionMismatch,
): Promise<void> {
  await recordSystemEventSafe({
    category: "razorpay_webhook",
    severity: "INFO",
    message: `Dispute ${mismatch.disputeId} ${mismatch.verdict}: the gateway reported ${mismatch.reportedDeductedPaise} paise deducted against ${mismatch.disputedPaise} paise disputed; settled on ${mismatch.settledPaise} paise`,
    context: { ...mismatch },
    correlationId: `dispute:${mismatch.disputeId}`,
  });
}

const noMismatch = (
  settlement: LostDisputeSettlement,
): DisputeVerdictSettlement => ({ ...settlement, deductionMismatch: null });

/**
 * The money half of a dispute verdict, shared by the webhook and the
 * reconcile-disputes poll so both write the same rows. `amountDeductedPaise`
 * is Razorpay's `amount_deducted`, or null when the gateway sent none.
 */
export async function settleDisputeVerdict(
  tx: Tx,
  dispute: DisputeSettlementInput,
  verdict: DisputeStatus,
  amountDeductedPaise: number | null,
): Promise<DisputeVerdictSettlement> {
  switch (verdict) {
    case "WON":
    case "WARNING_CLOSED":
      return noMismatch(await settleWonDispute(tx, dispute));
    case "LOST":
    case "CHARGE_REFUNDED": {
      const { settledPaise, mismatch } = lostDisputeAmount(
        dispute,
        verdict,
        amountDeductedPaise,
      );
      return {
        ...(await settleLostDispute(tx, dispute, settledPaise)),
        deductionMismatch: mismatch,
      };
    }
    case "CLOSED":
      return noMismatch(
        await settleClosedDispute(tx, dispute, amountDeductedPaise),
      );
    default:
      return noMismatch(NO_CLAWBACK_PAGE);
  }
}

/**
 * Handle dispute updated event (status change, evidence submitted, etc.)
 */
const TERMINAL_DISPUTE_STATUSES = new Set<DisputeStatus>([
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
  "CLOSED",
  "WARNING_CLOSED",
]);

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
  respondBy?: number | null,
): Promise<{
  notification: StagedTrigger | null;
  emails: StagedRecipientEmail[];
}> {
  const canStageEmail =
    typeof tx.user?.findMany === "function" &&
    typeof tx.failedEmail?.create === "function";
  const dashboardUrl = `${getAppUrl()}${goHref("client", "payments")}`;

  if (priorStatus === "UNDER_REVIEW" && mappedStatus === "NEEDS_RESPONSE") {
    const disputePayment = await tx.payment.findUnique({
      where: { id: dispute.paymentId },
    });
    if (!disputePayment) return { notification: null, emails: [] };
    const notifications = await notifyDisputeCreated(
      [disputePayment.userId],
      {
        disputeId,
        amount: dispute.amountPaise,
        currency: dispute.currency,
        reason: dispute.reason || "",
        status: mappedStatus,
        dashboardUrl,
      },
      { tx, entityRef: `dispute:${disputeId}:reopened` },
    );
    const emails = canStageEmail
      ? await stageDisputeNoticeEmail(tx, {
          userId: disputePayment.userId,
          disputeId,
          paymentId: dispute.paymentId,
          kind: "OPENED",
          amountPaise: dispute.amountPaise,
          currency: dispute.currency,
          reason: dispute.reason,
          respondBy: respondBy ? new Date(respondBy * 1000) : null,
          dashboardUrl,
        })
      : [];
    return { notification: notifications?.[0]?.staged ?? null, emails };
  }

  if (TERMINAL_DISPUTE_STATUSES.has(mappedStatus)) {
    const disputePayment = await tx.payment.findUnique({
      where: { id: dispute.paymentId },
    });
    if (!disputePayment) return { notification: null, emails: [] };
    const notifications = await notifyDisputeResolved(
      [disputePayment.userId],
      {
        disputeId,
        amount: dispute.amountPaise,
        currency: dispute.currency,
        reason: dispute.reason || undefined,
        status: mappedStatus,
        dashboardUrl,
      },
      { tx, entityRef: `dispute:${disputeId}` },
    );
    const emails = canStageEmail
      ? await stageDisputeNoticeEmail(tx, {
          userId: disputePayment.userId,
          disputeId,
          paymentId: dispute.paymentId,
          kind: "RESOLVED",
          amountPaise: dispute.amountPaise,
          currency: dispute.currency,
          reason: dispute.reason,
          outcome: mappedStatus,
          dashboardUrl,
        })
      : [];
    return { notification: notifications?.[0]?.staged ?? null, emails };
  }

  return { notification: null, emails: [] };
}

export async function handleDisputeUpdated(
  disputeId: string,
  status: string,
  evidence: Prisma.InputJsonValue | null,
  respondBy?: number | null,
  amountDeductedPaise: number | null = null,
  phase: string | null = null,
  webhookEventId: string | null = null,
) {
  const txOutcome = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const dispute = await tx.dispute.findUnique({
          where: { disputeId },
          include: { payment: { select: { id: true, amount: true } } },
        });

        if (!dispute) {
          console.warn(`Dispute not found: ${disputeId}`);
          return {
            deferred: new DeferSignal("dispute_not_created_yet"),
            notification: null,
            emails: [] as StagedRecipientEmail[],
            clawbackPage: null,
          };
        }

        const mappedStatus = mapDisputeStatus(status);
        const priorStatus = dispute.status;
        const terminalChange = isTerminalDisputeChange(
          priorStatus,
          mappedStatus,
          phase,
        );
        if (mappedStatus === null) {
          return {
            notification: null,
            emails: [] as StagedRecipientEmail[],
            clawbackPage: null,
            unadopted: {
              severity: terminalChange ? "ERROR" : "WARN",
              dispute,
              incomingStatus: status,
              phase,
            } satisfies UnadoptedDisputeEvent,
          };
        }

        if (
          priorStatus === mappedStatus ||
          !isLegalDisputeTransition(priorStatus, mappedStatus)
        ) {
          return {
            notification: null,
            emails: [] as StagedRecipientEmail[],
            clawbackPage: null,
            unadopted: terminalChange
              ? ({
                  severity: "ERROR",
                  dispute,
                  incomingStatus: status,
                  phase,
                } satisfies UnadoptedDisputeEvent)
              : null,
          };
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
            return {
              notification: null,
              emails: [] as StagedRecipientEmail[],
              clawbackPage: null,
            };
          }
        } else {
          await tx.dispute.update({
            where: { disputeId },
            data: updateData,
          });
        }

        const { consultantClawbackPage: clawbackPage, deductionMismatch } =
          await settleDisputeVerdict(
            tx,
            dispute,
            mappedStatus,
            amountDeductedPaise,
          );

        const stagedNotice = await stageDisputeUpdatedNotification(
          tx,
          dispute,
          priorStatus,
          mappedStatus,
          disputeId,
          respondBy,
        );

        return {
          notification: stagedNotice.notification,
          emails: stagedNotice.emails,
          clawbackPage,
          deductionMismatch,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );

  await Promise.allSettled([
    attemptStaged(txOutcome.notification),
    attemptStagedEmails(
      txOutcome.emails,
      MONEY_EMAIL_TYPES.DISPUTE_NOTICE,
      EMAIL_BUDGET_MS.WEBHOOK,
    ),
  ]);

  if (txOutcome.deductionMismatch) {
    await recordDeductionMismatch(txOutcome.deductionMismatch);
  }

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

  if (txOutcome.unadopted) {
    await recordUnadoptedDisputeEvent(txOutcome.unadopted, webhookEventId);
  }

  return txOutcome.deferred;
}

/**
 * #776 §C — settle a lost chargeback on an org-funded booking. The org funded
 * the booking, so the org bears the chargeback: debit its wallet. If the wallet
 * can't cover it (or there's no wallet), record the amount as an ORG_RECEIVABLE
 * the dunning flow pursues. Either way the gateway clearing (pulled by the bank)
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

  // Balanced counter-post: the gateway deducted the chargeback; recover it from the funder.
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
        account: gatewayCashAccount(),
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
      description: `Chargeback settled: ${formatCurrencyAmount(amountPaise, "INR")} ${
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

  if (eventType === "payout.reversed" || payoutData.status === "reversed") {
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
