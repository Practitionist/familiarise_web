import type { Tx } from "@/lib/prisma";

/**
 * Gives back the discount-code use a checkout consumed when its PENDING payment
 * ends unpaid. Call it only on the caller's PENDING → EXPIRED/FAILED CAS win, so
 * one payment returns its use at most once; a paid booking keeps its use, even
 * when later refunded.
 */
export async function returnDiscountUse(
  tx: Pick<Tx, "payment" | "discountCode">,
  paymentId: string,
): Promise<void> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { discountCodeId: true },
  });
  if (!payment?.discountCodeId) return;
  await tx.discountCode.updateMany({
    where: { id: payment.discountCodeId, currentUses: { gt: 0 } },
    data: { currentUses: { decrement: 1 } },
  });
}
