import type { PrismaLike, Tx } from "@/lib/prisma";
import { revokeReplayEntitlement } from "@/lib/payments/recording-entitlement";

/** The buyer's live purchase of the product: the one SUCCEEDED row the partial unique allows. */
export async function findDigitalProductEntitlement(
  db: PrismaLike,
  productId: string,
  buyerId: string,
): Promise<{ id: string; firstDownloadedAt: Date | null } | null> {
  return db.digitalProductPurchase.findFirst({
    where: { productId, buyerId, status: "SUCCEEDED" },
    select: { id: true, firstDownloadedAt: true },
  });
}

export async function hasDigitalProductEntitlement(
  db: PrismaLike,
  productId: string,
  buyerId: string,
): Promise<boolean> {
  return (await findDigitalProductEntitlement(db, productId, buyerId)) !== null;
}

/** A fully refunded or charged-back sale stops entitling downloads; answers whether it revoked one. */
export async function revokeDigitalProductEntitlement(
  tx: Tx,
  paymentId: string,
): Promise<boolean> {
  const revoked = await tx.digitalProductPurchase.updateMany({
    where: { paymentId, status: "SUCCEEDED" },
    data: { status: "REFUNDED" },
  });
  return revoked.count > 0;
}

/**
 * Revoke what an appointment-less payment entitled. A digital product sale is
 * found by its linked purchase; otherwise the replay sale by its order id.
 */
export async function revokeStandaloneSaleEntitlement(
  tx: Tx,
  payment: { id: string; paymentIntent: string },
): Promise<void> {
  const productSale = await tx.digitalProductPurchase.findUnique({
    where: { paymentId: payment.id },
    select: { id: true },
  });
  if (productSale) {
    await revokeDigitalProductEntitlement(tx, payment.id);
    return;
  }
  await revokeReplayEntitlement(tx, payment.paymentIntent);
}
