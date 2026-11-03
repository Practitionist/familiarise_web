import type { PrismaLike, Tx } from "@/lib/prisma";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";

/**
 * A capture that funds no booking parks its cash in the UNAPPLIED_RECEIPTS
 * liability until a refund returns it; it never touches revenue, GST or earnings.
 */
const unappliedReceiptKey = (paymentId: string): string =>
  `unapplied:${paymentId}`;

/** An operator recovery that books the capture releases the parked cash first. */
const releasedReceiptKey = (paymentId: string): string =>
  `unapplied-released:${paymentId}`;

/** Dr GATEWAY_CLEARING / Cr UNAPPLIED_RECEIPTS for the captured paise, in the capture's own transaction. */
export async function postUnappliedReceipt(
  tx: Tx,
  input: { paymentId: string; capturedPaise: number },
): Promise<void> {
  if (input.capturedPaise <= 0) return;
  await postLedgerTxn(tx, {
    idempotencyKey: unappliedReceiptKey(input.paymentId),
    kind: "UNAPPLIED_RECEIPT",
    description: "Capture funds no booking; parked until refunded",
    paymentId: input.paymentId,
    postings: [
      {
        account: gatewayCashAccount(),
        direction: "DEBIT",
        amountPaise: input.capturedPaise,
      },
      {
        account: { kind: "UNAPPLIED_RECEIPTS" },
        direction: "CREDIT",
        amountPaise: input.capturedPaise,
      },
    ],
  });
}

/**
 * Dr GATEWAY_CLEARING / Cr UNAPPLIED_RECEIPTS for an org-invoice capture no
 * invoice can claim, keyed by the gateway `pay_…` id. True only when newly parked.
 */
export async function postUnappliedInvoiceReceipt(
  tx: Tx,
  input: {
    gatewayPaymentId: string;
    invoiceId: string | null;
    capturedPaise: number;
  },
): Promise<boolean> {
  if (input.capturedPaise <= 0) return false;
  const { created } = await postLedgerTxn(tx, {
    idempotencyKey: unappliedReceiptKey(input.gatewayPaymentId),
    kind: "UNAPPLIED_RECEIPT",
    description: "Org-invoice capture settles no invoice; parked for ops",
    invoiceId: input.invoiceId,
    postings: [
      {
        account: gatewayCashAccount(),
        direction: "DEBIT",
        amountPaise: input.capturedPaise,
      },
      {
        account: { kind: "UNAPPLIED_RECEIPTS" },
        direction: "CREDIT",
        amountPaise: input.capturedPaise,
      },
    ],
  });
  return created;
}

/** Whether the payment's cash is parked rather than booked (posted and not released). */
export async function hasUnappliedReceipt(
  tx: Tx,
  paymentId: string,
): Promise<boolean> {
  const parked = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: unappliedReceiptKey(paymentId) },
    select: { id: true },
  });
  if (!parked) return false;
  const released = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: releasedReceiptKey(paymentId) },
    select: { id: true },
  });
  return released === null;
}

/**
 * The captured paise still parked for this payment (the capture less what its
 * refunds already returned), or null when nothing was ever parked.
 */
export async function parkedReceiptPaise(
  db: Pick<PrismaLike, "ledgerEntry">,
  paymentId: string,
): Promise<number | null> {
  const entries = await db.ledgerEntry.findMany({
    where: {
      account: { kind: "UNAPPLIED_RECEIPTS" },
      transaction: { paymentId },
    },
    select: { direction: true, amountPaise: true },
  });
  if (entries.length === 0) return null;
  return entries.reduce(
    (sum, e) =>
      sum +
      (e.direction === "CREDIT"
        ? sumPaise(e.amountPaise)
        : -sumPaise(e.amountPaise)),
    0,
  );
}

/**
 * Dr UNAPPLIED_RECEIPTS / Cr GATEWAY_CLEARING for the parked paise, so the
 * booking journal that follows debits the clearing once. A no-op when nothing was parked.
 */
export async function releaseUnappliedReceipt(
  tx: Tx,
  paymentId: string,
): Promise<void> {
  // Only what is still parked: refunds of the parked capture already returned part of it.
  const remainingPaise = (await parkedReceiptPaise(tx, paymentId)) ?? 0;
  if (remainingPaise <= 0) return;
  await postLedgerTxn(tx, {
    idempotencyKey: releasedReceiptKey(paymentId),
    kind: "UNAPPLIED_RECEIPT",
    description: "Parked capture recovered into a booking",
    paymentId,
    postings: [
      {
        account: { kind: "UNAPPLIED_RECEIPTS" },
        direction: "DEBIT",
        amountPaise: remainingPaise,
      },
      {
        account: gatewayCashAccount(),
        direction: "CREDIT",
        amountPaise: remainingPaise,
      },
    ],
  });
}

/** Dr UNAPPLIED_RECEIPTS / Cr GATEWAY_CLEARING: the refund of a parked capture returns only the cash. */
export async function postUnappliedRefund(
  tx: Tx,
  input: { paymentId: string; refundId: string; amountPaise: number },
): Promise<void> {
  await postLedgerTxn(tx, {
    idempotencyKey: `refund:${input.refundId}`,
    kind: "REFUND",
    paymentId: input.paymentId,
    postings: [
      {
        account: { kind: "UNAPPLIED_RECEIPTS" },
        direction: "DEBIT",
        amountPaise: input.amountPaise,
      },
      {
        account: gatewayCashAccount(),
        direction: "CREDIT",
        amountPaise: input.amountPaise,
      },
    ],
  });
}
