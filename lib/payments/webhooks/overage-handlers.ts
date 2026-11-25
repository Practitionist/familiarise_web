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
 * Capture posts `Dr GATEWAY_CLEARING / Cr DISCOUNT(base) / Cr PLATFORM_FEE(surcharge) /
 * Cr GST_PAYABLE`: checkout carved the base off the org's leg and the platform funded it
 * as DISCOUNT, so the member's base reverses that discount; the org is credited nothing.
 * Reconcile (OVERAGE_SETTLEMENT_MISMATCH) asserts every CHARGED event has that txn.
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
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import {
  recarveOverageBase,
  releaseOverageHeldParentEarnings,
  restoreOverageBaseCarve,
} from "@/lib/payments/billing/overage-base-carve";
import {
  recordSystemErrorSafe,
  recordSystemEventSafe,
} from "@/lib/enterprise/system-events";
import { mintInvoiceRefundCreditNote } from "@/lib/payments/operations/refund";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import { postUnappliedReceipt } from "@/lib/payments/ledger/unapplied-receipts";
import {
  autoRefundPendingDescription,
  unreturnedCaptureWhere,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { prorate } from "@/lib/payments/utils/money";

type OverageTxOutcome =
  | { kind: "settled"; sideId: string }
  | {
      kind: "mismatch_refund";
      sideId: string;
      capturedPaise: number;
      organizationId: string | null;
      reason: string;
    }
  | null;

/** A side payment is settled only when every overage event it pays is CHARGED. */
function overageCharged(events: { chargeStatus: string }[]): boolean {
  return events.length > 0 && events.every((e) => e.chargeStatus === "CHARGED");
}

/**
 * A captured side payment whose overage is not CHARGED is not settled. One
 * operator event says so, unless the capture is already being returned (the
 * refund path owns that row). Nothing is charged or posted from here.
 */
async function reportCapturedUncharged(
  tx: Tx,
  side: { id: string; organizationId: string | null },
  paymentIntentId: string,
  events: { chargeStatus: string }[],
): Promise<void> {
  const kept = await tx.payment.count({
    where: { id: side.id, ...unreturnedCaptureWhere },
  });
  if (kept === 0) return;
  const correlationId = `overage-captured-uncharged:${side.id}`;
  const alreadyRecorded = await tx.systemEvent.findFirst({
    where: { correlationId, category: "OVERAGE" },
    select: { id: true },
  });
  if (alreadyRecorded) return;
  await recordSystemErrorSafe({
    db: tx,
    organizationId: side.organizationId,
    category: "OVERAGE",
    summary: `Overage side-payment ${side.id} is captured but its overage is not charged; settle or refund it by hand`,
    err: new Error("OVERAGE_CAPTURED_NOT_CHARGED"),
    context: {
      sidePaymentId: side.id,
      paymentIntentId,
      chargeStatuses: events.map((e) => e.chargeStatus),
    },
    correlationId,
  });
}

/**
 * Gateway capture succeeded for a CHARGE_MEMBER side-charge. Idempotent on the
 * side-Payment status + the `overage:<id>` ledger key.
 */
async function checkFastPathSettledOverage(
  paymentIntentId: string,
  capturedPaise?: number,
  gatewayPaymentId?: string,
): Promise<boolean> {
  if (!prisma.payment?.findUnique) return false;
  const existingSide = await prisma.payment.findUnique({
    where: { paymentIntent: paymentIntentId },
    select: {
      id: true,
      paymentStatus: true,
      amount: true,
      gatewayPaymentId: true,
      overageEvents: { select: { chargeStatus: true } },
    },
  });
  if (
    !existingSide ||
    existingSide.paymentStatus !== PaymentStatus.SUCCEEDED ||
    (capturedPaise !== undefined && capturedPaise !== existingSide.amount) ||
    !overageCharged(existingSide.overageEvents)
  ) {
    return false;
  }
  if (gatewayPaymentId && !existingSide.gatewayPaymentId) {
    await prisma.payment.updateMany({
      where: { id: existingSide.id, gatewayPaymentId: null },
      data: { gatewayPaymentId },
    });
  }
  return true;
}

async function resolveInvoicedBaseAfterRecarve(
  tx: Tx,
  sideId: string,
  organizationId: string | null,
  paymentIntentId: string,
): Promise<{
  basePaise: number;
  invoiceId: string;
  overageEventId: string;
} | null> {
  const recarve = await recarveOverageBase(tx, { sidePaymentId: sideId });
  if (recarve !== "invoiced") return null;

  const ctx = await tx.overageEvent.findFirst({
    where: { paymentId: sideId },
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
    return {
      basePaise: ctx.basePaise,
      invoiceId,
      overageEventId: ctx.id,
    };
  }
  await recordSystemErrorSafe({
    db: tx,
    organizationId,
    category: "OVERAGE",
    summary: `Late capture of overage side-payment ${sideId} after the parent was invoiced — the base credit could not be neutralised (no basePaise / invoice link); manual billing adjustment needed`,
    err: new Error("OVERAGE_RECARVE_AFTER_INVOICE"),
    context: { sidePaymentId: sideId, paymentIntentId },
  });
  return null;
}

async function postOverageMemberLedgerEntries(
  tx: Tx,
  side: { id: string; amount: number; taxAmount: number },
): Promise<void> {
  if (side.amount <= 0) return;
  const taxPaise = Math.min(side.taxAmount, side.amount);
  const event = await tx.overageEvent.findFirst({
    where: { paymentId: side.id },
    select: { basePaise: true },
  });
  const basePaise = Math.min(event?.basePaise ?? 0, side.amount - taxPaise);
  const credits: Posting[] = [
    {
      account: { kind: "DISCOUNT" },
      direction: "CREDIT",
      amountPaise: basePaise,
    },
    {
      account: { kind: "PLATFORM_FEE" },
      direction: "CREDIT",
      amountPaise: side.amount - taxPaise - basePaise,
    },
    {
      account: { kind: "GST_PAYABLE" },
      direction: "CREDIT",
      amountPaise: taxPaise,
    },
  ];
  await postLedgerTxn(tx, {
    idempotencyKey: `overage:${side.id}`,
    kind: "OVERAGE_MEMBER",
    paymentId: side.id,
    postings: [
      {
        account: gatewayCashAccount(),
        direction: "DEBIT",
        amountPaise: side.amount,
      },
      ...credits.filter((c) => c.amountPaise > 0),
    ],
  });
}

async function settleOverageSidePaymentInTx(
  tx: Tx,
  paymentIntentId: string,
  capturedPaise: number | undefined,
  gatewayPaymentId?: string,
): Promise<OverageTxOutcome> {
  const side = await tx.payment.findUnique({
    where: { paymentIntent: paymentIntentId },
    select: {
      id: true,
      amount: true,
      taxAmount: true,
      organizationId: true,
      paymentStatus: true,
      parentPaymentId: true,
    },
  });
  if (!side || capturedPaise === undefined) return null;
  const capturedGatewayId = gatewayPaymentId ? { gatewayPaymentId } : {};

  // A parentless EXPIRED row is the tombstone of a replaced order: park the capture and auto-refund it.
  if (!side.parentPaymentId) {
    if (side.paymentStatus !== PaymentStatus.EXPIRED) return null;
    const claimed = await tx.payment.updateMany({
      where: { id: side.id, paymentStatus: PaymentStatus.EXPIRED },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        ...capturedGatewayId,
        capturedAt: new Date(),
        description: autoRefundPendingDescription(
          `capture landed on replaced overage order ${paymentIntentId}`,
        ),
      },
    });
    if (claimed.count === 0) return null;
    await postUnappliedReceipt(tx, { paymentId: side.id, capturedPaise });
    return {
      kind: "mismatch_refund",
      sideId: side.id,
      capturedPaise,
      organizationId: side.organizationId,
      reason:
        "Capture on a replaced overage order; auto-refunding gateway truth",
    };
  }
  if (side.paymentStatus === PaymentStatus.SUCCEEDED) {
    const events = await tx.overageEvent.findMany({
      where: { paymentId: side.id },
      select: { chargeStatus: true },
    });
    if (!overageCharged(events)) {
      await reportCapturedUncharged(tx, side, paymentIntentId, events);
    }
    return null;
  }
  if (capturedPaise !== side.amount) {
    const stamped = await tx.payment.updateMany({
      where: {
        id: side.id,
        paymentStatus: {
          in: [PaymentStatus.PENDING, PaymentStatus.FAILED],
        },
      },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        ...capturedGatewayId,
        description: autoRefundPendingDescription(
          `capture amount ${capturedPaise}p != expected ${side.amount}p`,
        ),
      },
    });
    if (stamped.count === 0) return null;
    await postUnappliedReceipt(tx, {
      paymentId: side.id,
      capturedPaise,
    });
    return {
      kind: "mismatch_refund",
      sideId: side.id,
      capturedPaise,
      organizationId: side.organizationId,
      reason:
        "Overage side-payment capture amount != expected; auto-refunding gateway truth",
    };
  }

  let claimed = await tx.payment.updateMany({
    where: { id: side.id, paymentStatus: side.paymentStatus },
    data: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      ...capturedGatewayId,
    },
  });
  if (claimed.count === 0) {
    const current = await tx.payment.findUnique({
      where: { id: side.id },
      select: { paymentStatus: true },
    });
    if (current?.paymentStatus !== PaymentStatus.FAILED) return null;
    claimed = await tx.payment.updateMany({
      where: { id: side.id, paymentStatus: PaymentStatus.FAILED },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        ...capturedGatewayId,
      },
    });
    if (claimed.count === 0) return null;
  }

  const updatedLeg = await tx.paymentLeg.updateMany({
    where: { paymentId: side.id, source: "CARD" },
    data: { sourceRef: paymentIntentId },
  });
  if (updatedLeg?.count === 0) {
    await tx.paymentLeg.create({
      data: {
        paymentId: side.id,
        source: "CARD",
        amountPaise: side.amount,
        sourceRef: paymentIntentId,
      },
    });
  }

  const settledAt = new Date();
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
      invoicedBase = await resolveInvoicedBaseAfterRecarve(
        tx,
        side.id,
        side.organizationId,
        paymentIntentId,
      );
    }
  }

  if (moved === 0) {
    // The overage is no longer the member's to pay (reversed, or settled to the
    // org): park the cash and auto-refund it after commit; the marker re-drives it.
    await tx.payment.update({
      where: { id: side.id },
      data: {
        description: autoRefundPendingDescription(
          "captured after its overage was reversed",
        ),
      },
    });
    await postUnappliedReceipt(tx, { paymentId: side.id, capturedPaise });
    return {
      kind: "mismatch_refund",
      sideId: side.id,
      capturedPaise,
      organizationId: side.organizationId,
      reason:
        "Overage side-payment captured after its overage was reversed; auto-refunding",
    };
  }

  await releaseOverageHeldParentEarnings(tx, side.parentPaymentId, side.id);
  await postOverageMemberLedgerEntries(tx, side);

  if (invoicedBase) {
    await neutraliseInvoicedOverageBase(tx, {
      sidePaymentId: side.id,
      organizationId: side.organizationId,
      paymentIntentId,
      ...invoicedBase,
    });
  }
  return { kind: "settled", sideId: side.id };
}

export async function handleOverageMemberSuccess(
  paymentIntentId: string,
  capturedPaise?: number,
  gatewayPaymentId?: string,
): Promise<void> {
  if (
    await checkFastPathSettledOverage(
      paymentIntentId,
      capturedPaise,
      gatewayPaymentId,
    )
  ) {
    return;
  }

  const txOutcome: OverageTxOutcome = await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) =>
        settleOverageSidePaymentInTx(
          tx,
          paymentIntentId,
          capturedPaise,
          gatewayPaymentId,
        ),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  // Same document path as a booking capture: the member's own tax invoice.
  // A mismatched capture is refunded, never invoiced.
  if (txOutcome?.kind === "settled") {
    await mintConsumerInvoiceBestEffort({ paymentId: txOutcome.sideId });
  }
  if (txOutcome?.kind === "mismatch_refund") {
    try {
      await refundBookingPayment({
        paymentId: txOutcome.sideId,
        amountPaise: txOutcome.capturedPaise,
        reason: txOutcome.reason,
        dedupeKey: `overage-mismatch:${txOutcome.sideId}`,
      });
    } catch (err) {
      // The SUCCEEDED + marker stamp above lets retry-auto-refunds re-drive.
      await recordSystemErrorSafe({
        organizationId: txOutcome.organizationId,
        category: "OVERAGE",
        summary: `Overage mismatch refund failed for side-payment ${txOutcome.sideId} - sweeper backstop owns it`,
        err: err instanceof Error ? err : new Error(String(err)),
        context: { sidePaymentId: txOutcome.sideId, paymentIntentId },
      });
    }
  }
}

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
  const key = `overage-recarve-invoice:${sidePaymentId}`;

  // The org was already invoiced the base, so the member's base pays down its receivable.
  if (organizationId) {
    await postLedgerTxn(tx, {
      idempotencyKey: key,
      kind: "OVERAGE_MEMBER",
      paymentId: sidePaymentId,
      invoiceId,
      description: `Overage base already invoiced — move the member's base for side-payment ${sidePaymentId} onto the org's receivable`,
      postings: [
        {
          account: { kind: "DISCOUNT" },
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
  const taxPaise = invoice
    ? invoice.igstPaise + invoice.cgstPaise + invoice.sgstPaise
    : 0;
  const grossBasePaise =
    invoice && invoice.subtotalPaise > 0
      ? basePaise + prorate(basePaise, taxPaise, invoice.subtotalPaise, "round")
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

  const creditNoteLabel = creditNoteId
    ? `credit note ${creditNoteId}`
    : outcome === "FULLY_CREDITED"
      ? "no note issued — the invoice is already credited in full"
      : "NO credit note (invoice not issued / not found) — manual billing adjustment still needed";
  const summary =
    `Late capture of overage side-payment ${sidePaymentId} after its ` +
    `parent was invoiced — base ${basePaise}p moved onto ORG_RECEIVABLE by ` +
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
  if (creditNoteId) {
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

export async function handleOverageMemberFailure(
  paymentIntentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const side = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true, parentPaymentId: true },
    });
    if (!side || !side.parentPaymentId) return;
    if (side.paymentStatus === PaymentStatus.SUCCEEDED) return;

    const failed = await tx.payment.updateMany({
      where: { id: side.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.FAILED },
    });
    if (failed.count === 0) return;
    const moved = await transitionOverage(tx, { paymentId: side.id }, "FAILED");
    if (moved > 0) {
      const restore = await restoreOverageBaseCarve(tx, {
        sidePaymentId: side.id,
      });
      if (restore === "invoiced") {
        await recordSystemErrorSafe({
          db: tx,
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
