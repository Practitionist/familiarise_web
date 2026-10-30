import type { Tx } from "@/lib/prisma";

/** Serialises every file-set change of one product: reservations, verifications and removals. */
export async function lockDigitalProductRow(
  tx: Tx,
  productId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "DigitalProduct" WHERE id = ${productId} FOR UPDATE`;
}
