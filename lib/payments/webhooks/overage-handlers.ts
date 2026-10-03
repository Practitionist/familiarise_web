/**
 * #775 — CHARGE_MEMBER overage side-charge settlement.
 *
 * When a program with `overageBehavior = CHARGE_MEMBER` is booked past its
 * cap, checkout creates a parent-linked PENDING `Payment` (the side-charge,
 * `parentPaymentId` = the booking payment) + an `OverageEvent` (chargeStatus
 * PENDING). The member completes the side-charge via the resume-checkout
 * surface (`POST /api/overage/[overageEventId]/order`, which mints the gateway
 * order and stamps it onto `paymentIntent`); these handlers run on the gateway
 * webhook for that order.
 *
 * Money model (org-relief, DECIDED #775): the org funded the covered portion
 * of the booking and the consultant was paid once at booking; the member's
 * marginal relieves the org. Capture posts `Dr CASH / Cr ORG_PAYABLE(org)`
 * for the FULL marginal (base + surcharge), and that credit is REALIZED AT
 * ORG PAYOUT — it flows to the org through the next payout batch like any
 * other payable. There is NO invoice-netting and NO wallet credit-back for
 * member overage money; the ledger payable is the single realization path.
 * Reconcile asserts every CHARGED member event has its `overage:<sidePaymentId>`
 * txn with Cr ORG_PAYABLE == marginalPaise (OVERAGE_SETTLEMENT_MISMATCH).
 *
 * The one exception is the FAILED→CHARGED late capture whose parent had already
 * rolled onto an org invoice while the base sat restored: `recarveOverageBase`
 * declines to touch an issued document, so the org already owes the base on that
 * invoice. See `neutraliseInvoicedOverageBase` for the correction.
 */
import prisma from "@/lib/prisma";
import type { Tx } from "@/lib/prisma";
import { PaymentStatus, Prisma } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import {
  recarveOverageBase,
  restoreOverageBaseCarve,
} from "@/lib/payments/billing/overage-base-carve";
import {
  recordSystemErrorSafe,
  recordSystemEventSafe,
} from "@/lib/enterprise/system-events";
import { mintInvoiceRefundCreditNote } from "@/lib/payments/operations/refund";

/**
 * Gateway capture succeeded for a CHARGE_MEMBER side-charge. Idempotent on the
 * side-Payment status + the `overage:<id>` ledger key.
 */
export async function handleOverageMemberSuccess(
  paymentIntentId: string,
): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
    const side = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        amount: true,
        organizationId: true,
        paymentStatus: true,
        parentPaymentId: true,
      },
    });
    if (!side || !side.parentPaymentId) {
      // Not an overage side-charge (or already gone) — nothing to do.
      return;
    }
    if (side.paymentStatus === PaymentStatus.SUCCEEDED) {
      return; // already settled
    }

    // #1846 SM-B2 — CAS on the status just read. A plain update let a
    // concurrent delivery's write be silently overwritten; with the predicate
    // in the WHERE, Postgres re-checks it after the other transaction commits,
    // so exactly one delivery settles the side-charge.
    let claimed = await tx.payment.updateMany({
      where: { id: side.id, paymentStatus: side.paymentStatus },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });
    if (claimed.count === 0) {
      // #1846 SM-B2 — a failure delivery can commit FAILED between the read
      // and the claim. The capture is gateway truth, so claim once more from
      // FAILED; the FAILED→CHARGED edge below then recarves the base. Any
      // other status means a concurrent capture already settled it.
      const current = await tx.payment.findUnique({
        where: { id: side.id },
        select: { paymentStatus: true },
      });
      if (current?.paymentStatus !== PaymentStatus.FAILED) return;
      claimed = await tx.payment.updateMany({
        where: { id: side.id, paymentStatus: PaymentStatus.FAILED },
        data: { paymentStatus: PaymentStatus.SUCCEEDED },
      });
      if (claimed.count === 0) return;
    }

    // Every Payment must carry ≥1 leg (the funding invariant). The member paid
    // by card; sourceRef is the gateway order id.
    await tx.paymentLeg.upsert({
      where: { paymentId_source: { paymentId: side.id, source: "CARD" } },
      create: {
        paymentId: side.id,
        source: "CARD",
        amountPaise: side.amount,
        sourceRef: paymentIntentId,
      },
      update: {},
    });

    // Transition FIRST so the journal below mirrors the state machine: the
    // org-relief credit posts only for an event that actually became CHARGED.
    // Two-step CAS (#812): which edge fired matters — FAILED→CHARGED is a
    // late capture whose basePaise was restored to the org accrual when the
    // sweep FAILed it, so it must be carved back out; PENDING/ACCRUED→CHARGED
    // is still carved. A read-then-check would race the sweeps.
    const settledAt = new Date();
    // Set when the recarve declines (parent already invoiced); acted on AFTER
    // the org-relief journal below.
    let invoicedBase: {
      basePaise: number;
      invoiceId: string;
      overageEventId: string;
    } | null = null;
    let moved = await transitionOverage(
      tx,
      { paymentId: side.id },
      "CHARGED",
      { settledAt },
      { fromIn: ["PENDING", "ACCRUED"] },
    );
    if (moved === 0) {
      moved = await transitionOverage(
        tx,
        { paymentId: side.id },
        "CHARGED",
        { settledAt },
        { fromIn: ["FAILED"] },
      );
      if (moved > 0) {
        const recarve = await recarveOverageBase(tx, {
          sidePaymentId: side.id,
        });
        if (recarve === "invoiced") {
          // The org was already invoiced for the restored base while the
          // charge sat FAILED. The capture is honoured; the base is neutralised
          // after the org-relief posting, so read the base and its invoice.
          const ctx = await tx.overageEvent.findFirst({
            where: { paymentId: side.id },
            select: {
              id: true,
              basePaise: true,
              payment: {
                select: {
                  parentPayment: {
                    select: { billableToOrgInvoiceId: true },
                  },
                },
              },
            },
          });
          const invoiceId = ctx?.payment?.parentPayment?.billableToOrgInvoiceId;
          if (ctx && invoiceId && ctx.basePaise > 0) {
            invoicedBase = {
              basePaise: ctx.basePaise,
              invoiceId,
              overageEventId: ctx.id,
            };
          } else {
            // The event vanished or lost its parent link between the recarve
            // and this read. Nothing can be neutralised, so say so durably
            // rather than posting the base credit and moving on.
            await recordSystemErrorSafe({
              db: tx,
              organizationId: side.organizationId,
              category: "OVERAGE",
              summary: `Late capture of overage side-payment ${side.id} after the parent was invoiced — the base credit could not be neutralised (no basePaise / invoice link); manual billing adjustment needed`,
              err: new Error("OVERAGE_RECARVE_AFTER_INVOICE"),
              context: { sidePaymentId: side.id, paymentIntentId },
            });
          }
        }
      }
    }

    if (moved === 0) {
      // Capture raced a reversal: the booking refunded (event → REVERSED)
      // after the order was minted but before this webhook landed. Money was
      // collected for an obligation that no longer exists — do NOT credit the
      // org; surface it for a manual side-payment refund instead (#782).
      void recordSystemErrorSafe({
        organizationId: side.organizationId,
        category: "OVERAGE",
        summary: `Overage side-payment ${side.id} captured but its OverageEvent could not move to CHARGED (likely REVERSED mid-flight) — refund the side-payment`,
        err: new Error("OVERAGE_CAPTURED_AFTER_REVERSAL"),
        context: { sidePaymentId: side.id, paymentIntentId },
      });
      return;
    }

    if (side.amount > 0 && side.organizationId) {
      const postings: Posting[] = [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: side.amount,
        },
        {
          account: { kind: "ORG_PAYABLE", organizationId: side.organizationId },
          direction: "CREDIT",
          amountPaise: side.amount,
        },
      ];
      await postLedgerTxn(tx, {
        idempotencyKey: `overage:${side.id}`,
        kind: "OVERAGE_MEMBER",
        paymentId: side.id,
        postings,
      });
    }

    if (invoicedBase) {
      await neutraliseInvoicedOverageBase(tx, {
        sidePaymentId: side.id,
        organizationId: side.organizationId,
        paymentIntentId,
        ...invoicedBase,
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
}

/**
 * Correct a late member capture whose base the org was ALREADY invoiced for:
 * invoiced money must never also be credited to ORG_PAYABLE. In the caller's
 * tx: (1) `Dr ORG_PAYABLE / Cr ORG_RECEIVABLE` for the base, keyed
 * `overage-recarve-invoice:<sidePaymentId>`; (2) a GST credit note for the
 * grossed-up base via `mintInvoiceRefundCreditNote`, unique per OverageEvent.
 * Both keys are fixed per capture, so a redelivery applies once.
 */
async function neutraliseInvoicedOverageBase(
  tx: Tx,
  args: {
    sidePaymentId: string;
    organizationId: string | null;
    paymentIntentId: string;
    basePaise: number;
    invoiceId: string;
    overageEventId: string;
  },
): Promise<void> {
  const {
    sidePaymentId,
    organizationId,
    paymentIntentId,
    basePaise,
    invoiceId,
    overageEventId,
  } = args;
  // Same key space for the journal and the document: this side-Payment's base
  // is reversed exactly once, on either rail or both.
  const key = `overage-recarve-invoice:${sidePaymentId}`;

  if (organizationId) {
    await postLedgerTxn(tx, {
      idempotencyKey: key,
      kind: "OVERAGE_MEMBER",
      paymentId: sidePaymentId,
      invoiceId,
      description: `Overage base already invoiced — reverse the org-relief credit for side-payment ${sidePaymentId}`,
      postings: [
        {
          account: { kind: "ORG_PAYABLE", organizationId },
          direction: "DEBIT",
          amountPaise: basePaise,
        },
        {
          account: { kind: "ORG_RECEIVABLE", organizationId },
          direction: "CREDIT",
          amountPaise: basePaise,
        },
      ],
    });
  }

  const invoice = await tx.organizationInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      invoiceNumber: true,
      subtotalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
    },
  });
  // Gross the tax-exclusive base up by the invoice's own rate; a DRAFT invoice
  // is refused by the canonical writer's own guard.
  const taxPaise = invoice
    ? invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise
    : 0;
  const grossBasePaise =
    invoice && invoice.subtotalPaise > 0
      ? basePaise + Math.round((basePaise * taxPaise) / invoice.subtotalPaise)
      : basePaise;

  const { creditNoteId, outcome } = await mintInvoiceRefundCreditNote(tx, {
    invoiceId,
    overageEventId,
    amountPaise: grossBasePaise,
    exactSubtotalPaise: basePaise,
    reason:
      `Overage base for side-payment ${sidePaymentId} was paid ` +
      `directly by the member; credit it back against invoice ` +
      `${invoice?.invoiceNumber ?? invoiceId}`,
  });

  if (creditNoteId) {
    await tx.organizationInvoice.updateMany({
      where: { id: invoiceId, providerPaymentOrderId: { not: null } },
      data: { providerPaymentOrderId: null },
    });
  }

  // Awaited through the tx (#1582 B-P1-02) so a rollback drops it too; `*Safe`
  // never throws.
  const creditNoteLabel = creditNoteId
    ? `credit note ${creditNoteId}`
    : outcome === "FULLY_CREDITED"
      ? "no note issued — the invoice is already credited in full"
      : "NO credit note (invoice not issued / not found) — manual billing adjustment still needed";
  const summary =
    `Late capture of overage side-payment ${sidePaymentId} after its ` +
    `parent was invoiced — base ${basePaise}p pulled off ORG_PAYABLE by ` +
    `reversal ${key} and credited back on the invoice by ${creditNoteLabel}`;
  const context = {
    sidePaymentId,
    paymentIntentId,
    invoiceId,
    basePaise,
    grossBasePaise,
    creditNoteId,
    creditNoteOutcome: outcome ?? null,
    ledgerReversalKey: key,
  };
  if (creditNoteId && typeof recordSystemEventSafe === "function") {
    await recordSystemEventSafe({
      db: tx,
      organizationId,
      category: "OVERAGE",
      severity: "INFO",
      message: summary,
      context: {
        action: "OVERAGE_INVOICED_BASE_NEUTRALISED",
        ...context,
      },
    });
  } else {
    await recordSystemErrorSafe({
      db: tx,
      organizationId,
      category: "OVERAGE",
      summary,
      err: new Error("OVERAGE_RECARVE_AFTER_INVOICE"),
      context,
    });
  }
}

/**
 * Gateway capture failed/abandoned for a CHARGE_MEMBER side-charge. Marks the
 * side-Payment FAILED + the OverageEvent FAILED so the dashboard can surface a
 * retry. The booking itself is unaffected (it already happened).
 */
export async function handleOverageMemberFailure(
  paymentIntentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const side = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true, parentPaymentId: true },
    });
    if (!side || !side.parentPaymentId) return;
    if (side.paymentStatus === PaymentStatus.SUCCEEDED) return; // don't undo a success

    // #1846 SM-B2 — the money predicate rides the WHERE. The SUCCEEDED
    // pre-check above reads before the capture transaction commits, so a
    // failure delivery racing it used to overwrite SUCCEEDED with FAILED while
    // the OverageEvent stayed CHARGED and the org credit stayed posted. Only a
    // PENDING side-charge can fail; zero rows means capture (or an earlier
    // failure) got there first, and nothing below may run.
    const failed = await tx.payment.updateMany({
      where: { id: side.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    if (failed.count === 0) return;
    const moved = await transitionOverage(tx, { paymentId: side.id }, "FAILED");
    if (moved > 0) {
      // #812 §P0 — the member isn't paying basePaise; return it to the org's
      // parent accrual in the same tx. "invoiced" (parent already rolled onto
      // an invoice) is surfaced by the sweeps when they re-FAIL; here the
      // charge stays retryable so a recarve on recovery rebalances it.
      const restore = await restoreOverageBaseCarve(tx, {
        sidePaymentId: side.id,
      });
      if (restore === "invoiced") {
        void recordSystemErrorSafe({
          organizationId: null,
          category: "OVERAGE",
          summary: `Failed overage side-payment ${side.id}: basePaise not restorable — parent already invoiced; manual billing adjustment needed`,
          err: new Error("OVERAGE_BASE_RESTORE_AFTER_INVOICE"),
          context: { sidePaymentId: side.id, paymentIntentId },
        });
      }
    }
  });
}
