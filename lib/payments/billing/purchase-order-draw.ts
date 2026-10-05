/**
 * The one purchase-order draw-down: a CAS decrement of `remainingAmountPaise`
 * that holds only while the PO is ACTIVE, in the invoice's currency, and still
 * covers the invoice total. Shared by the manual invoice route and the rollup.
 * Restoration on VOID / CANCELLED lives in the invoice PATCH route.
 */

import type { Currency } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

export async function drawPurchaseOrder(
  tx: Tx,
  input: {
    purchaseOrderId: string;
    organizationId: string;
    currency: Currency;
    amountPaise: number;
  },
): Promise<boolean> {
  const claim = await tx.purchaseOrder.updateMany({
    where: {
      id: input.purchaseOrderId,
      organizationId: input.organizationId,
      status: "ACTIVE",
      currency: input.currency,
      remainingAmountPaise: { gte: input.amountPaise },
    },
    data: { remainingAmountPaise: { decrement: input.amountPaise } },
  });
  return claim.count === 1;
}

/** Draws the oldest unexpired ACTIVE PO that covers the amount; null when none does. */
export async function drawCoveringPurchaseOrder(
  tx: Tx,
  input: {
    organizationId: string;
    currency: Currency;
    amountPaise: number;
    now: Date;
  },
): Promise<string | null> {
  const candidates = await tx.purchaseOrder.findMany({
    where: {
      organizationId: input.organizationId,
      status: "ACTIVE",
      currency: input.currency,
      remainingAmountPaise: { gte: input.amountPaise },
      OR: [{ validUntil: null }, { validUntil: { gte: input.now } }],
    },
    orderBy: { poDate: "asc" },
    select: { id: true },
  });
  for (const po of candidates) {
    if (await drawPurchaseOrder(tx, { ...input, purchaseOrderId: po.id })) {
      return po.id;
    }
  }
  return null;
}
