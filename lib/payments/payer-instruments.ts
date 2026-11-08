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

/** Stamps the payer hashes once on the captured Payment; a replay or a second event is a no-op. */
export async function recordPayerInstruments(
  db: PrismaLike,
  gatewayPaymentId: string,
  entity: PayerInstrumentFields,
): Promise<void> {
  const hashes = payerInstrumentHashes(entity);
  if (!hashes.payerVpaHash && !hashes.payerPhoneHash) return;
  await db.payment.updateMany({
    where: { gatewayPaymentId, payerVpaHash: null, payerPhoneHash: null },
    data: hashes,
  });
}
