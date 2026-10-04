import type { Tx } from "@/lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";

/**
 * A capture staged for auto-refund funds no booking, so its cash is parked in
 * the UNAPPLIED_RECEIPTS liability until the refund returns it; it never
 * touches revenue, GST or earnings.
 */
export const UNAPPLIED_RECEIPT_KEY_PREFIX = "unapplied:";

export const unappliedReceiptKey = (paymentId: string): string =>
  `${UNAPPLIED_RECEIPT_KEY_PREFIX}${paymentId}`;

/** Dr CASH / Cr UNAPPLIED_RECEIPTS for the captured paise, in the capture's own transaction. */
export async function postUnappliedReceipt(
  tx: Tx,
  input: { paymentId: string; capturedPaise: number },
): Promise<void> {
  if (input.capturedPaise <= 0) return;
  await postLedgerTxn(tx, {
    idempotencyKey: unappliedReceiptKey(input.paymentId),
    kind: "BOOKING",
    description: "Capture staged for auto-refund; funds no booking",
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

/** Whether the payment's cash was parked rather than booked. */
export async function hasUnappliedReceipt(
  tx: Tx,
  paymentId: string,
): Promise<boolean> {
  const parked = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey: unappliedReceiptKey(paymentId) },
    select: { id: true },
  });
  return parked !== null;
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
