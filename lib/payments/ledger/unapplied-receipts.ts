import type { Tx } from "@/lib/prisma";
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

/** Dr CASH / Cr UNAPPLIED_RECEIPTS for the captured paise, in the capture's own transaction. */
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
        account: { kind: "CASH" },
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
 * Dr UNAPPLIED_RECEIPTS / Cr CASH for the parked paise, so the booking journal
 * that follows debits CASH once. A no-op when nothing was parked.
 */
export async function releaseUnappliedReceipt(
  tx: Tx,
  paymentId: string,
): Promise<void> {
  // Only what is still parked: refunds of the parked capture already returned part of it.
  const entries = await tx.ledgerEntry.findMany({
    where: {
      account: { kind: "UNAPPLIED_RECEIPTS" },
      transaction: { paymentId },
    },
    select: { direction: true, amountPaise: true },
  });
  const remainingPaise = entries.reduce(
    (sum, e) =>
      sum +
      (e.direction === "CREDIT"
        ? sumPaise(e.amountPaise)
        : -sumPaise(e.amountPaise)),
    0,
  );
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
        account: { kind: "CASH" },
        direction: "CREDIT",
        amountPaise: remainingPaise,
      },
    ],
  });
}

/** Dr UNAPPLIED_RECEIPTS / Cr CASH: the refund of a parked capture returns only the cash. */
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
        account: { kind: "CASH" },
        direction: "CREDIT",
        amountPaise: input.amountPaise,
      },
    ],
  });
}
