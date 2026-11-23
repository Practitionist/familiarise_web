import type { Prisma, RefundStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { settleRefundSeatTx, type SeatDecision } from "./refund-seat";

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Retires a `pending_` placeholder whose gateway refund id a webhook row already holds, re-pointing a bound support
 * recommendation first (its FK is Restrict). A winner already SUCCEEDED decides its seat here, from the inherited intent.
 */
export async function retireSupersededPlaceholderTx(
  tx: Tx,
  placeholder: {
    id: string;
    dedupeKey: string | null;
    metadata: Prisma.JsonValue | null;
  },
  winnerId: string,
): Promise<{ status: RefundStatus; seat: SeatDecision } | null> {
  const winner = await tx.refund.findUniqueOrThrow({
    where: { id: winnerId },
    select: { metadata: true, status: true },
  });
  await tx.supportFinancialRecommendation.updateMany({
    where: { refundId: placeholder.id },
    data: { refundId: winnerId },
  });
  const retired = await tx.refund.deleteMany({
    where: { id: placeholder.id, status: "PENDING", cascadedAt: null },
  });
  if (retired.count === 0) {
    // A concurrent retirement already removed it; a surviving row changed state and must not be dropped.
    const still = await tx.refund.findUnique({
      where: { id: placeholder.id },
      select: { id: true },
    });
    if (!still) return null;
    throw new Error(
      `Refund placeholder ${placeholder.id} is no longer a pending, uncascaded reservation; refusing to retire it`,
    );
  }
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
  // Runs in the caller's Serializable transaction; a PENDING winner is decided by its own settle.
  return {
    status: winner.status,
    seat: await settleRefundSeatTx(tx, winnerId),
  };
}
