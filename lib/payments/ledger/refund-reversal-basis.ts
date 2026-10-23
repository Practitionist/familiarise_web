import type { Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

export type RefundReversalBasis = {
  /** DISCOUNT to credit back: `share` of the booked net, or the whole remainder on the completing refund. */
  discountBackPaise: number;
  /** GST_PAYABLE the payment's earlier refund journals already debited. */
  gstReversedPaise: number;
};

/** One read of a payment's DISCOUNT and GST_PAYABLE lines, booking-side (incl. carves) vs refunds. */
export async function refundReversalBasis(
  tx: Tx,
  paymentId: string,
  share: (paise: number) => number,
  completes: boolean,
): Promise<RefundReversalBasis> {
  const entries = await tx.ledgerEntry.findMany({
    where: {
      account: { kind: { in: ["DISCOUNT", "GST_PAYABLE"] } },
      transaction: { paymentId },
    },
    select: {
      direction: true,
      amountPaise: true,
      account: { select: { kind: true } },
      transaction: { select: { kind: true } },
    },
  });
  let booked = 0;
  let remaining = 0;
  let gstReversedPaise = 0;
  for (const e of entries) {
    const signed = (e.direction === "DEBIT" ? 1 : -1) * sumPaise(e.amountPaise);
    const isRefund = e.transaction.kind === "REFUND";
    if (e.account.kind === "GST_PAYABLE") {
      if (isRefund) gstReversedPaise += signed;
      continue;
    }
    remaining += signed;
    if (!isRefund) booked += signed;
  }
  let discountBackPaise = 0;
  if (remaining > 0) {
    discountBackPaise = completes
      ? remaining
      : Math.min(share(Math.max(booked, 0)), remaining);
  }
  return { discountBackPaise, gstReversedPaise };
}
