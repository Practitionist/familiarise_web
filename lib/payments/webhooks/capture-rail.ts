/**
 * Which rail a gateway order belongs to, read from the rows the app wrote
 * when it minted that order. The gateway's notes never select a rail the
 * app's own rows can name.
 */
import type { PrismaLike } from "@/lib/prisma";
import { parseMintedOrderId } from "@/lib/api/organizations/wallet";

export type CaptureRail =
  | { rail: "booking" }
  | { rail: "overage" }
  | { rail: "recording_purchase" }
  | { rail: "digital_product_purchase" }
  /** `notes` are the organisation handlers' inputs, built from the row. */
  | { rail: "wallet_top_up"; notes: Record<string, string> }
  | { rail: "org_invoice"; notes: Record<string, string> }
  /** No row names this order. */
  | { rail: "unknown" };

export type CaptureRailName = CaptureRail["rail"];

/** The rail an order's `notes.type` names, for the cross-check and for an order no row names. */
const RAIL_OF_NOTE_TYPE: Readonly<Record<string, CaptureRailName>> = {
  credit_purchase: "wallet_top_up",
  invoice_payment: "org_invoice",
  overage_member: "overage",
  recording_purchase: "recording_purchase",
  digital_product_purchase: "digital_product_purchase",
};

/** The rail the notes claim; null when they carry no type, which claims nothing. */
export function railNamedByNotes(
  notes: Record<string, string>,
): CaptureRailName | null {
  if (!notes.type) return null;
  return RAIL_OF_NOTE_TYPE[notes.type] ?? null;
}

/**
 * Resolve an order id against every table that stores one. The standalone
 * sales are read before `Payment` because their capture writes a Payment row
 * under the same order id.
 */
export async function resolveCaptureRail(
  db: PrismaLike,
  orderId: string,
): Promise<CaptureRail> {
  if (!orderId) return { rail: "unknown" };

  const recording = await db.recordingPurchase.findUnique({
    where: { gatewayOrderId: orderId },
    select: { id: true },
  });
  if (recording) return { rail: "recording_purchase" };

  const digital = await db.digitalProductPurchase.findUnique({
    where: { gatewayOrderId: orderId },
    select: { id: true },
  });
  if (digital) return { rail: "digital_product_purchase" };

  const payment = await db.payment.findUnique({
    where: { paymentIntent: orderId },
    select: { parentPaymentId: true },
  });
  if (payment) {
    // A side payment names its booking payment; a replaced order's tombstone names none.
    return { rail: payment.parentPaymentId ? "overage" : "booking" };
  }

  const invoice = await db.organizationInvoice.findFirst({
    where: { providerPaymentOrderId: orderId },
    select: { id: true, organizationId: true },
  });
  if (invoice) {
    return {
      rail: "org_invoice",
      notes: {
        type: "invoice_payment",
        invoiceId: invoice.id,
        organizationId: invoice.organizationId,
      },
    };
  }

  // The top-up row keeps its minted order inside `notes`; the exact id is
  // re-read from each candidate, so a longer id sharing the prefix never matches.
  const topUps = await db.walletTopUp.findMany({
    where: { notes: { contains: `razorpay_order=${orderId}` } },
    select: {
      providerOrderId: true,
      amountPaise: true,
      notes: true,
      billingAccountId: true,
      billingAccount: { select: { ownerOrgId: true } },
    },
    take: 5,
  });
  const topUp = topUps.find((row) => parseMintedOrderId(row.notes) === orderId);
  if (topUp) {
    return {
      rail: "wallet_top_up",
      notes: {
        type: "credit_purchase",
        walletEntryOrderId: topUp.providerOrderId,
        organizationId: topUp.billingAccount.ownerOrgId,
        billingAccountId: topUp.billingAccountId,
        amountPaise: String(topUp.amountPaise),
      },
    };
  }

  return { rail: "unknown" };
}
