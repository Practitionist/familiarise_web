/**
 * The one purchase-order draw-down: a CAS decrement of `remainingAmountPaise`
 * that holds only while the PO is ACTIVE, unexpired, in the invoice's currency,
 * and still covers the invoice total. Shared by the manual invoice route and the rollup.
 * A credit note returns its share of the draw (`restorePurchaseOrderForCredit`);
 * a cancelled DRAFT returns all of it in the invoice PATCH route.
 */

import type { Currency } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { prorate } from "@/lib/payments/utils/money";

export async function drawPurchaseOrder(
  tx: Tx,
  input: {
    purchaseOrderId: string;
    organizationId: string;
    currency: Currency;
    amountPaise: number;
    now: Date;
  },
): Promise<boolean> {
  const claim = await tx.purchaseOrder.updateMany({
    where: {
      id: input.purchaseOrderId,
      organizationId: input.organizationId,
      status: "ACTIVE",
      currency: input.currency,
      remainingAmountPaise: { gte: input.amountPaise },
      OR: [{ validUntil: null }, { validUntil: { gte: input.now } }],
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

/**
 * Return the share of a PO draw a credit note frees: its total, or for a
 * tax-free commercial note its subtotal grossed up at the invoice's rate.
 * Capped at what the PO has spent, so `purchase_order_amounts_coherent` holds.
 */
export async function restorePurchaseOrderForCredit(
  tx: Tx,
  input: {
    invoice: {
      purchaseOrderId: string | null;
      totalPaise: number;
      subtotalPaise: number;
    };
    credit: {
      totalPaise: number;
      subtotalPaise: number;
      isCommercial: boolean;
    };
  },
): Promise<number> {
  const { invoice, credit } = input;
  if (!invoice.purchaseOrderId) return 0;
  const freed = credit.isCommercial
    ? grossedUpSubtotal(credit.subtotalPaise, invoice)
    : credit.totalPaise;
  const want = Math.min(freed, invoice.totalPaise);
  if (want <= 0) return 0;
  // CAS on the balance read, so a concurrent draw or restore re-reads it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: invoice.purchaseOrderId },
      select: { totalAmountPaise: true, remainingAmountPaise: true },
    });
    if (!po) return 0;
    const restorePaise = Math.min(
      want,
      po.totalAmountPaise - po.remainingAmountPaise,
    );
    if (restorePaise <= 0) return 0;
    const moved = await tx.purchaseOrder.updateMany({
      where: {
        id: invoice.purchaseOrderId,
        remainingAmountPaise: po.remainingAmountPaise,
      },
      data: { remainingAmountPaise: { increment: restorePaise } },
    });
    if (moved.count === 1) return restorePaise;
  }
  throw new Error(
    `PurchaseOrder ${invoice.purchaseOrderId} kept moving while a credit restored its draw`,
  );
}

/** A tax-free commercial note's subtotal at the invoice's gross rate. */
function grossedUpSubtotal(
  subtotalPaise: number,
  invoice: { totalPaise: number; subtotalPaise: number },
): number {
  if (invoice.subtotalPaise <= 0) return 0;
  return prorate(
    subtotalPaise,
    invoice.totalPaise,
    invoice.subtotalPaise,
    "round",
  );
}
