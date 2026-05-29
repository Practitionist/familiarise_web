import prisma from "../../../lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { Prisma, PaymentGateway } from "@prisma/client";
import crypto from "crypto";
import { stripeClient } from "@/lib/payments/core/stripe";
import { razorpayClient } from "@/lib/payments/core/razorpay";
import { handlePayoutWebhook, refundEarnings } from "@/lib/payments/payouts";
import {
  notifyRefundProcessed,
  notifyDisputeCreated,
  notifyDisputeResolved,
} from "@/lib/novu";
import {
  notifyOrgInvoicePaid,
  notifyOrgWalletTopupConfirmed,
} from "@/lib/novu/org-workflows";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { getAppUrl } from "@/lib/url";
import { confirmTopUp, walletCredit } from "@/lib/api/organizations/wallet";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// Re-export payment handlers from lib (architectural fix)
export {
  handlePaymentSuccess,
  handlePaymentFailure,
} from "@/lib/payments/webhooks/handlers";

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
    if (
      gatewayAmountPaise !== undefined &&
      paise !== gatewayAmountPaise
    ) {
      console.error(
        `[Webhook] credit_purchase ${walletEntryOrderId} notes.amountPaise=${paise} ≠ gatewayAmount=${gatewayAmountPaise}. Skipping wallet credit.`,
      );
      if (organizationId) {
        prisma.orgAuditLog
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
        prisma.orgAuditLog
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
      select: { id: true, totalPaise: true, status: true, displayCurrency: true, organizationId: true },
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
        prisma.orgAuditLog
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
        const claimed = await tx.organizationInvoice.updateMany({
          where: { id: invoiceId, status: { in: ["ISSUED", "OVERDUE"] } },
          data: {
            status: "PAID",
            paidAt: new Date(),
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
                  account: { kind: "ORG_RECEIVABLE", organizationId: resolvedOrgId },
                  direction: "CREDIT",
                  amountPaise: invoiceRow.totalPaise,
                },
              ],
            });
          }
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
      prisma.orgAuditLog
        .create({
          data: {
            organizationId: resolvedOrgId,
            actorMembershipId: null,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
            description: `Invoice ${invoiceId} paid via webhook`,
            details: { invoiceId, providerPaymentId: razorpayPaymentId ?? null },
          },
        })
        .catch((err) =>
          console.error("[Webhook] Failed to write INVOICE_PAID audit log:", err),
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
        }).catch((err) =>
          console.error("[notifyOrgInvoicePaid] failed:", err),
        );
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
      console.error("[Webhook] credit_purchase.failed missing walletEntryOrderId");
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
      prisma.orgAuditLog
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
      prisma.orgAuditLog
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

/**
 * Lightweight DB health check for webhook handlers.
 *
 * Returns false when the DB is unreachable or mid-migration.
 * Webhook handlers should return 503 when this is false — payment gateways
 * (Stripe, Razorpay, etc.) will retry the webhook automatically after a
 * delay, so no events are lost.
 */
export async function isDbHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// Generic webhook verification
export async function verifyWebhookSignature(
  req: Request,
  secret: string,
  gateway: "stripe" | "razorpay",
): Promise<{ isValid: boolean; body: string }> {
  const signature =
    req.headers.get("stripe-signature") ||
    req.headers.get("x-razorpay-signature");

  if (!signature) {
    return { isValid: false, body: "" };
  }

  const body = await req.text();

  try {
    if (gateway === "stripe") {
      if (!stripeClient) {
        console.error(
          "Stripe client not initialized - cannot verify webhook signature",
        );
        return { isValid: false, body: "" };
      }
      stripeClient.webhooks.constructEvent(body, signature, secret);
      return { isValid: true, body };
    } else {
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");
      // H1 FIX: Use timing-safe comparison to prevent timing attacks on HMAC
      // Validate hex length before Buffer.from (odd-length strings get truncated)
      if (signature.length !== 64) {
        return { isValid: false, body };
      }
      const sigBuf = Buffer.from(signature, "hex");
      const expectedBuf = Buffer.from(expectedSignature, "hex");
      if (sigBuf.length !== expectedBuf.length) {
        return { isValid: false, body };
      }
      return { isValid: crypto.timingSafeEqual(sigBuf, expectedBuf), body };
    }
  } catch (error) {
    console.error(
      `Webhook signature verification failed for ${gateway}:`,
      error,
    );
    return { isValid: false, body };
  }
}

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
 * the org-level branches; for Stripe we keep the legacy `paymentIntentId`
 * contract.
 */
export async function handleRefundCreated(
  refundId: string,
  paymentIntentId: string,
  amount: number,
  currency: string,
  status: string,
  gateway: "STRIPE" | "RAZORPAY",
  providerPaymentId?: string,
) {
  return await prisma.$transaction(async (tx) => {
    // Find the payment (B2C appointment path)
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
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
        const mapped = mapRefundStatus(status);
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
          const posted = await postLedgerTxn(tx, {
            idempotencyKey: `topup-refund:${providerPaymentId}`,
            kind: "TOPUP_REFUND",
            description: `Refund for top-up ${topUp.providerOrderId} (gateway refund ${refundId})`,
            postings: [
              {
                account: {
                  kind: "WALLET",
                  organizationId: acct.ownerOrgId,
                  currency: acct.currency,
                },
                direction: "DEBIT",
                amountPaise: refundAmt,
              },
              {
                account: { kind: "CASH", currency: acct.currency },
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
          // (idempotencyKey topup-refund:<rzp payment id>) is the
          // authoritative record; reconcile jobs index on it.
          await tx.$executeRaw`
            UPDATE "BillingAccount"
            SET "walletBalance" = COALESCE("walletBalance", 0) - ${refundAmt}
            WHERE "id" = ${topUp.billingAccountId}
          `;
          console.log(
            `💸 Top-up refund ${refundId} booked: -${refundAmt} paise on billingAccount ${topUp.billingAccountId}`,
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
          totalPaise: true,
          status: true,
        },
      });
      if (invoice) {
        const mapped = mapRefundStatus(status);
        if (mapped === "SUCCEEDED") {
          if (invoice.status === "REFUNDED") {
            console.log(
              `💸 Invoice ${invoice.id} already REFUNDED, skipping`,
            );
            return;
          }
          await tx.organizationInvoice.update({
            where: { id: invoice.id },
            data: { status: "REFUNDED" },
          });
          // NOTE: Booking-level utilization reversal is keyed on
          // individual Payment ids (BookingUtilization.paymentId @unique),
          // not on the invoice. Invoices that roll up many bookings do
          // not have a single paymentId to feed `reverseBookingUtilization`
          // — a follow-up phase (after the invoice-line-item schema lands)
          // will iterate over linked line-items and reverse each one
          // individually. For now, the compensating WalletEntry credit
          // below plus the INVOICE_REFUNDED audit log is the guaranteed
          // bookkeeping; the operator runbook calls out bookings that
          // may need manual reversal.
          await tx.orgAuditLog.create({
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
          }).catch((err) =>
            console.error(
              `⚠️ Failed to write INVOICE_REFUNDED audit log:`,
              err,
            ),
          );
          // Opportunistic: if wallet-based funding was used, credit the
          // refund amount back. Swallow if no wallet flow applies.
          try {
            const ba = await tx.billingAccount.findFirst({
              where: { ownerOrgId: invoice.organizationId },
              select: { id: true, fundingSource: true },
            });
            if (ba && ba.fundingSource === "WALLET") {
              await walletCredit(tx, {
                billingAccountId: ba.id,
                amountPaise: amount,
                reason: "REFUND",
                providerPaymentId,
                notes: `Invoice ${invoice.invoiceNumber} refund (${refundId})`,
              });
            }
          } catch (err) {
            console.warn(
              `⚠️ Wallet credit for invoice refund ${refundId} skipped:`,
              err,
            );
          }
          console.log(
            `💸 Invoice refund ${refundId} booked for invoice ${invoice.id}`,
          );
        }
        return;
      }

      console.warn(
        `Payment not found for refund: ${refundId} (paymentIntent=${paymentIntentId}, providerPaymentId=${providerPaymentId})`,
      );
      return;
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
      refundAmt?: number,
      originalPaymentAmt?: number,
    ) => {
      if (mapRefundStatus(refundStatus) !== "SUCCEEDED") return;

      try {
        // Check if any refund for this payment has forceRefund in metadata
        // (read is done on `tx` so we see Refund rows inserted earlier in
        // this same transaction — otherwise the hasForceRefund check
        // would race with new refunds created moments before.)
        const refunds = await tx.refund.findMany({
          where: { paymentId },
          select: { metadata: true },
        });
        const hasForceRefund = refunds.some(
          (r) =>
            r.metadata &&
            typeof r.metadata === "object" &&
            (r.metadata as Record<string, unknown>).forceRefund === true,
        );

        // FIX #618: Pass refund amount context so partial refunds only
        // reverse a proportional share of earnings, not the full amount.
        // `tx` plumbed through so earnings reversal, TDS reversal, and
        // the Refund insert above all commit atomically.
        await refundEarnings(paymentId, {
          forceRefund: hasForceRefund,
          refundAmount: refundAmt,
          paymentAmount: originalPaymentAmt,
          tx,
        });
        console.log(`💰 Earnings refunded for payment ${paymentId}`);
      } catch (earningsError) {
        // Log but don't fail - earnings can be manually updated
        // refundEarnings already guards against double-refund (checks REFUNDED status)
        console.error(
          `⚠️ Failed to refund earnings for payment ${paymentId}:`,
          earningsError,
        );
      }

      // PR-1e Phase A: cap reversal for org-funded bookings. The
      // `BookingUtilization` row (if any) is keyed by paymentId and
      // exists only when the booking consumed engagements from a
      // program. Reversal is proportional to the refund ratio so a
      // partial refund returns a partial slice of the cap. Idempotent
      // via the ledger-derived "already reversed" check inside the
      // helper. Same try/catch posture as refundEarnings — log and
      // continue; the operator runbook flags any stuck rows that the
      // reconcile cron surfaces.
      try {
        const isPartial =
          refundAmt !== undefined &&
          originalPaymentAmt !== undefined &&
          originalPaymentAmt > 0 &&
          refundAmt < originalPaymentAmt;
        let engagementsToReverse: number | undefined;
        if (isPartial) {
          const util = await tx.bookingUtilization.findUnique({
            where: { paymentId },
            select: { engagementsConsumed: true },
          });
          if (util) {
            const ratio = refundAmt! / originalPaymentAmt!;
            engagementsToReverse = Math.max(
              0,
              Math.round(util.engagementsConsumed * ratio),
            );
          }
        }
        const result = await reverseBookingUtilization(tx, {
          paymentId,
          reason: isPartial
            ? `Partial refund (${refundAmt}/${originalPaymentAmt})`
            : "Refund",
          engagementsToReverse,
        });
        if (result.reversed) {
          console.log(
            `🪙 Cap reversal for payment ${paymentId}: -${result.engagementsReversed} engagements (fullyReversed=${result.fullyReversed})`,
          );
        }
      } catch (capError) {
        console.error(
          `⚠️ Failed to reverse cap utilization for payment ${paymentId}:`,
          capError,
        );
      }

      try {
        const restored = await reverseCreditsForPayment(
          paymentId,
          tx,
          refundAmt,
          originalPaymentAmt,
        );
        if (restored > 0) {
          console.log(
            `🔄 Reversed ${restored} referral credits for refunded payment ${paymentId}`,
          );
        }
      } catch (creditError) {
        console.error(
          `⚠️ Failed to reverse referral credits for payment ${paymentId}:`,
          creditError,
        );
      }
    };

    if (existingRefund) {
      // Update status if changed
      if (existingRefund.status !== status) {
        const newStatus = mapRefundStatus(status);
        const wasSucceeded = existingRefund.status === "SUCCEEDED";

        await tx.refund.update({
          where: { refundId },
          data: {
            status: newStatus,
            updatedAt: new Date(),
          },
        });
        console.log(`✅ Refund ${refundId} status updated to ${status}`);

        // Run side effects when transitioning TO SUCCEEDED (but not if already SUCCEEDED)
        if (!wasSucceeded) {
          await runRefundSideEffects(
            payment.id,
            status,
            amount,
            payment.amount,
          );
        }
      }
      return;
    }

    // Create new refund record
    await tx.refund.create({
      data: {
        amountPaise: amount,
        currency,
        status: mapRefundStatus(status),
        refundId,
        paymentGateway: gateway,
        paymentId: payment.id,
      },
    });

    console.log(`✅ Refund ${refundId} created for payment ${payment.id}`);

    // Run side effects for new refunds that are already SUCCEEDED
    await runRefundSideEffects(payment.id, status, amount, payment.amount);

    // --- Novu notification (fire-and-forget) ---
    void notifyRefundProcessed(payment.userId, {
      amount,
      currency,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
  });
}

function mapRefundStatus(
  status: string,
): "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" {
  switch (status.toLowerCase()) {
    case "succeeded":
    case "processed":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    default:
      return "PENDING";
  }
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
  gateway: "STRIPE" | "RAZORPAY",
) {
  return await prisma.$transaction(async (tx) => {
    // Find payment by charge ID or payment intent
    // For Stripe, we need to get the payment intent from the charge
    let payment;
    if (gateway === "STRIPE" && stripeClient) {
      try {
        const charge = await stripeClient.charges.retrieve(chargeId);
        if (charge.payment_intent) {
          payment = await tx.payment.findUnique({
            where: {
              paymentIntent:
                typeof charge.payment_intent === "string"
                  ? charge.payment_intent
                  : charge.payment_intent.id,
            },
          });
        }
      } catch (error) {
        console.error("Failed to retrieve charge:", error);
      }
    } else {
      // For Razorpay, chargeId is the payment_id. We need to fetch the payment
      // from Razorpay to get the order_id, which is stored as our paymentIntent.
      if (razorpayClient) {
        try {
          const rzpPayment = await razorpayClient.payments.fetch(chargeId);
          if (rzpPayment.order_id) {
            payment = await tx.payment.findUnique({
              where: { paymentIntent: rzpPayment.order_id },
            });
          }
        } catch (error) {
          console.error(
            `Failed to fetch Razorpay payment ${chargeId} to link dispute:`,
            error,
          );
        }
      }
    }

    if (!payment) {
      console.warn(`Payment not found for dispute: ${disputeId}`);
      return;
    }

    // Check if dispute already exists
    const existingDispute = await tx.dispute.findUnique({
      where: { disputeId },
    });

    if (existingDispute) {
      console.log(`Dispute ${disputeId} already exists`);
      return;
    }

    // Create dispute record
    await tx.dispute.create({
      data: {
        amountPaise: amount,
        currency,
        reason,
        status: mapDisputeStatus(status),
        disputeId,
        paymentGateway: gateway,
        dueBy: dueBy ? new Date(dueBy * 1000) : null,
        isChargeRefundable,
        paymentId: payment.id,
      },
    });

    console.log(`✅ Dispute ${disputeId} created for payment ${payment.id}`);

    // M1 FIX: Hold consultant earnings to prevent payout of disputed funds
    const heldResult = await tx.consultantEarnings.updateMany({
      where: {
        paymentId: payment.id,
        status: { in: ["PENDING", "READY"] },
      },
      data: { status: "HELD" },
    });
    if (heldResult.count > 0) {
      console.log(
        `🔒 ${heldResult.count} earnings held due to dispute ${disputeId}`,
      );
    }

    // --- Novu notification (fire-and-forget) ---
    void notifyDisputeCreated([payment.userId], {
      disputeId,
      amount,
      currency,
      reason,
      status: mapDisputeStatus(status),
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
  });
}

/**
 * Handle dispute updated event (status change, evidence submitted, etc.)
 */
export async function handleDisputeUpdated(
  disputeId: string,
  status: string,
  evidence: Record<string, unknown> | null,
) {
  return await prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({
      where: { disputeId },
    });

    if (!dispute) {
      console.warn(`Dispute not found: ${disputeId}`);
      return;
    }

    const mappedStatus = mapDisputeStatus(status);

    await tx.dispute.update({
      where: { disputeId },
      data: {
        status: mappedStatus,
        ...(evidence && { evidence: evidence as Prisma.InputJsonValue }),
        updatedAt: new Date(),
      },
    });

    console.log(`✅ Dispute ${disputeId} updated to status ${mappedStatus}`);

    // M1 FIX: Release or refund earnings based on dispute resolution
    if (mappedStatus === "WON" || mappedStatus === "WARNING_CLOSED") {
      // Dispute resolved in platform's favor — release held earnings back to READY
      const released = await tx.consultantEarnings.updateMany({
        where: { paymentId: dispute.paymentId, status: "HELD" },
        data: { status: "READY" },
      });
      if (released.count > 0) {
        console.log(`🔓 ${released.count} earnings released — dispute ${disputeId} won`);
      }
    } else if (mappedStatus === "LOST" || mappedStatus === "CHARGE_REFUNDED") {
      // Dispute lost — mark held earnings as REFUNDED, accounting for partial refunds
      const heldEarnings = await tx.consultantEarnings.findMany({
        where: { paymentId: dispute.paymentId, status: "HELD" },
        select: {
          id: true,
          consultantSharePaise: true,
          refundedShareAmount: true,
          consultantProfileId: true,
        },
      });
      for (const earning of heldEarnings) {
        const alreadyRefunded = earning.refundedShareAmount ?? 0;
        const remainingRefundable = Math.max(
          earning.consultantSharePaise - alreadyRefunded,
          0,
        );

        await tx.consultantEarnings.update({
          where: { id: earning.id },
          data: {
            status: "REFUNDED",
            ...(remainingRefundable > 0
              ? { refundedShareAmount: { increment: remainingRefundable } }
              : {}),
          },
        });

        if (remainingRefundable > 0) {
          await tx.consultantProfile.update({
            where: { id: earning.consultantProfileId },
            data: { pendingRevenue: { decrement: remainingRefundable } },
          });
        }
        console.log(`💸 Earnings ${earning.id} refunded (${remainingRefundable} paise) — dispute ${disputeId} lost`);
      }
    }

    // --- Novu notification for resolved disputes (fire-and-forget) ---
    const resolvedStatuses = [
      "WON",
      "LOST",
      "CHARGE_REFUNDED",
      "WARNING_CLOSED",
    ];
    if (resolvedStatuses.includes(mappedStatus)) {
      const disputePayment = await tx.payment.findUnique({
        where: { id: dispute.paymentId },
      });

      if (disputePayment) {
        void notifyDisputeResolved([disputePayment.userId], {
          disputeId,
          amount: dispute.amountPaise,
          currency: dispute.currency,
          reason: dispute.reason || undefined,
          status: mappedStatus,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
      }
    }
  });
}

function mapDisputeStatus(
  status: string,
):
  | "WARNING_NEEDS_RESPONSE"
  | "WARNING_UNDER_REVIEW"
  | "WARNING_CLOSED"
  | "NEEDS_RESPONSE"
  | "UNDER_REVIEW"
  | "CHARGE_REFUNDED"
  | "WON"
  | "LOST" {
  switch (status.toLowerCase()) {
    case "warning_needs_response":
      return "WARNING_NEEDS_RESPONSE";
    case "warning_under_review":
      return "WARNING_UNDER_REVIEW";
    case "warning_closed":
      return "WARNING_CLOSED";
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "charge_refunded":
      return "CHARGE_REFUNDED";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    default:
      return "NEEDS_RESPONSE";
  }
}

// ============================================================================
// Webhook Event Logging
// ============================================================================

/**
 * Log webhook event for audit trail and debugging.
 * Prevents duplicate processing via unique eventId constraint.
 *
 * If a previous attempt exists but failed (has error and processed=true),
 * it is eligible for retry — returns isNew: true so the handler re-runs.
 */
export async function logWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<{ isNew: boolean; eventRecordId?: string }> {
  try {
    // Check if event already exists
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      // Three-state machine using processed + error fields:
      //   processed=true  + no error  → SUCCESS: skip (idempotent)
      //   processed=true  + error set → FAILED:  allow retry (reset & re-process)
      //   processed=false + no error  → IN-PROGRESS: skip (another worker handling it)
      // This avoids a separate status enum while letting providers like Stream
      // retry failed events instead of silently dropping them.
      // If previously processed successfully, skip (true idempotency)
      if (existing.processed && !existing.error) {
        console.log(
          `⚠️ Webhook event ${eventId} already processed successfully, skipping`,
        );
        return { isNew: false, eventRecordId: existing.id };
      }

      // If previous attempt failed, allow retry by resetting state
      if (existing.error) {
        console.log(
          `🔄 Webhook event ${eventId} previously failed, allowing retry`,
        );
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        return { isNew: true, eventRecordId: existing.id };
      }

      // Currently being processed (processed=false, no error).
      // Add staleness check: if the event has been "in progress" for > 5 minutes,
      // treat it as abandoned (e.g., after() callback didn't run due to crash)
      // and allow reprocessing.
      const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const age = Date.now() - new Date(existing.receivedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        console.log(
          `🔄 Webhook event ${eventId} stale (in-progress for ${Math.round(age / 1000)}s), allowing retry`,
        );
        await prisma.webhookEvent.update({
          where: { eventId },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        return { isNew: true, eventRecordId: existing.id };
      }

      console.log(
        `⚠️ Webhook event ${eventId} currently being processed, skipping`,
      );
      return { isNew: false, eventRecordId: existing.id };
    }

    // Create new event record
    const event = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        signature,
        processed: false,
      },
    });

    return { isNew: true, eventRecordId: event.id };
  } catch (error) {
    // Handle unique constraint violation (race condition)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`⚠️ Webhook event ${eventId} duplicate (race condition)`);
      return { isNew: false };
    }
    throw error;
  }
}

/**
 * Mark webhook event as processed.
 * Only sets processed=true on success (no error).
 * On failure, records the error but leaves processed=true so the
 * retry logic in logWebhookEvent can detect it as a failed attempt.
 */
export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { eventId },
    data: {
      processed: true,
      processedAt: new Date(),
      error: error || null,
    },
  });
}

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
  },
): Promise<void> {
  // First: is this an OrganizationPayout? Look up by gatewayPayoutId.
  // Imported lazily to avoid a circular import (org-payout-service ->
  // org-workflows -> ... -> webhooks/utils when it grows).
  const { default: prismaClient } = await import("@/lib/prisma");
  const orgPayout = await prismaClient.organizationPayout.findUnique({
    where: { gatewayPayoutId: payoutData.id },
    select: { id: true, status: true, organizationId: true },
  });

  if (orgPayout) {
    const {
      markOrgPayoutCompleted,
      markOrgPayoutFailed,
      markOrgPayoutReversed,
    } = await import("@/lib/payments/payouts");

    switch (eventType) {
      case "payout.processed": {
        // Persist the bank UTR before flipping to COMPLETED so the
        // notification + audit log have the canonical reference.
        if (payoutData.utr) {
          await prismaClient.organizationPayout.update({
            where: { id: orgPayout.id },
            data: { gatewayUtr: payoutData.utr },
          });
        }
        await markOrgPayoutCompleted(orgPayout.id);
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
      // queued / initiated / pending / cancelled — informational only;
      // the row already sits in PROCESSING and we wait for the terminal
      // event. No state change here.
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
    cancelled: "CANCELLED",
  };

  const status = statusMap[payoutData.status] || "PENDING";

  await handlePayoutWebhook(
    PaymentGateway.RAZORPAY,
    payoutData.id,
    status,
    payoutData.failure_reason,
  );

  console.log(
    `✅ RazorpayX consultant payout ${payoutData.id} webhook processed: ${status}`,
  );
}

/**
 * Handle Stripe Connect payout/transfer webhook events
 */
export async function handleStripePayoutWebhook(
  eventType: string,
  payoutData: {
    id: string;
    status: string;
    failure_code?: string;
    failure_message?: string;
  },
): Promise<void> {
  // Map Stripe status to our internal status
  const statusMap: Record<
    string,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  > = {
    pending: "PENDING",
    in_transit: "PROCESSING",
    paid: "COMPLETED",
    failed: "FAILED",
    canceled: "CANCELLED",
  };

  const status = statusMap[payoutData.status] || "PENDING";
  const failureReason = payoutData.failure_message || payoutData.failure_code;

  await handlePayoutWebhook(
    PaymentGateway.STRIPE,
    payoutData.id,
    status,
    failureReason,
  );

  console.log(`✅ Stripe payout ${payoutData.id} webhook processed: ${status}`);
}

