import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Retires a `pending_` placeholder whose gateway refund id a webhook row already holds.
 * A support recommendation bound to the placeholder is re-pointed first (its FK is Restrict).
 */
export async function retireSupersededPlaceholderTx(
  tx: Tx,
  placeholder: {
    id: string;
    dedupeKey: string | null;
    metadata: Prisma.JsonValue | null;
  },
  winnerId: string,
): Promise<void> {
  const winner = await tx.refund.findUniqueOrThrow({
    where: { id: winnerId },
    select: { metadata: true },
  });
  await tx.supportFinancialRecommendation.updateMany({
    where: { refundId: placeholder.id },
    data: { refundId: winnerId },
  });
  await tx.refund.delete({ where: { id: placeholder.id } });
  await tx.refund.update({
    where: { id: winnerId },
    data: {
      ...(placeholder.dedupeKey ? { dedupeKey: placeholder.dedupeKey } : {}),
      metadata: {
        ...jsonObject(winner.metadata),
        ...jsonObject(placeholder.metadata),
      } as Prisma.InputJsonValue,
    },
  });
}
