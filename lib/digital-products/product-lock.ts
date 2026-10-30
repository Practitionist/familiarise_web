import type { Tx } from "@/lib/prisma";

/** Serialises every file-set change of one product: reservations, verifications and removals. */
export async function lockDigitalProductRow(
  tx: Tx,
  productId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "DigitalProduct" WHERE id = ${productId} FOR UPDATE`;
}

/** Locks the product row, then answers whether a buyer could download it: not taken down, a VERIFIED file. */
export async function lockDeliverableDigitalProduct(
  tx: Tx,
  productId: string,
): Promise<boolean> {
  await lockDigitalProductRow(tx, productId);
  const deliverable = await tx.digitalProduct.findFirst({
    where: {
      id: productId,
      takenDownAt: null,
      assets: { some: { status: "VERIFIED" } },
    },
    select: { id: true },
  });
  return deliverable !== null;
}
