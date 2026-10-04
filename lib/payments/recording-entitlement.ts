import type { Tx } from "@/lib/prisma";

/**
 * A refunded or charged-back replay sale stops entitling playback: every
 * entitlement read requires SUCCEEDED, so the purchase moves to REFUNDED.
 */
export async function revokeReplayEntitlement(
  tx: Tx,
  paymentIntent: string,
): Promise<void> {
  await tx.recordingPurchase.updateMany({
    where: { gatewayOrderId: paymentIntent, status: "SUCCEEDED" },
    data: { status: "REFUNDED" },
  });
}
