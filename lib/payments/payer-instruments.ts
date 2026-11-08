import type { PrismaLike } from "@/lib/prisma";
import { hashSignal } from "@/lib/referrals/signal-hash";

export interface PayerInstrumentFields {
  vpa?: string | null;
  contact?: string | null;
  upi?: { vpa?: string | null } | null;
}

/** The capture's UPI address and phone as HMACs; null fields when the payload carries none. */
export function payerInstrumentHashes(entity: PayerInstrumentFields): {
  payerVpaHash: string | null;
  payerPhoneHash: string | null;
} {
  return {
    payerVpaHash: hashSignal("vpa", entity.upi?.vpa ?? entity.vpa),
    payerPhoneHash: hashSignal("phone", entity.contact),
  };
}

/** Fills each still-null payer hash on the captured Payment; a recorded hash is never overwritten. */
export async function recordPayerInstruments(
  db: PrismaLike,
  gatewayPaymentId: string,
  entity: PayerInstrumentFields,
): Promise<void> {
  const { payerVpaHash, payerPhoneHash } = payerInstrumentHashes(entity);
  if (payerVpaHash) {
    await db.payment.updateMany({
      where: { gatewayPaymentId, payerVpaHash: null },
      data: { payerVpaHash },
    });
  }
  if (payerPhoneHash) {
    await db.payment.updateMany({
      where: { gatewayPaymentId, payerPhoneHash: null },
      data: { payerPhoneHash },
    });
  }
}
