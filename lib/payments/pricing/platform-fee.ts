import type { PaymentAttributionSource } from "@prisma/client";

import type { PrismaLike, Tx } from "@/lib/prisma";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";
import { prorate } from "@/lib/payments/utils/money";

/** Used only while no approved schedule exists: both rails at the marketplace rate. */
const FALLBACK_BPS = PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE * 100;

export interface ActiveFeeSchedule {
  id: string | null;
  marketplaceBps: number;
  ownLinkBps: number;
}

/** The latest approved schedule already in effect at `at`. */
export async function readActiveFeeSchedule(
  db: PrismaLike,
  at: Date = new Date(),
): Promise<ActiveFeeSchedule> {
  const row = await db.platformFeeSchedule.findFirst({
    where: { approvedAt: { not: null }, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { approvedAt: "desc" }],
    select: { id: true, marketplaceBps: true, ownLinkBps: true },
  });
  return (
    row ?? { id: null, marketplaceBps: FALLBACK_BPS, ownLinkBps: FALLBACK_BPS }
  );
}

export function feeBpsForSource(
  schedule: ActiveFeeSchedule,
  source: PaymentAttributionSource | null,
): number {
  return source === "OWN_LINK" ? schedule.ownLinkBps : schedule.marketplaceBps;
}

/** Spends one waived session by CAS; false when none is live. */
export async function consumeFeeWaiver(
  tx: Tx,
  consultantProfileId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const live = {
    consultantProfileId,
    sessionsRemaining: { gt: 0 },
    expiresAt: { gt: now },
  };
  const waiver = await tx.consultantFeeWaiver.findFirst({
    where: live,
    orderBy: { expiresAt: "asc" },
    select: { id: true },
  });
  if (!waiver) return false;
  const claimed = await tx.consultantFeeWaiver.updateMany({
    where: { id: waiver.id, ...live },
    data: { sessionsRemaining: { decrement: 1 } },
  });
  return claimed.count === 1;
}

type FeePayment = {
  id: string;
  userId: string;
  platformFeeBps: number | null;
  attributionSource: PaymentAttributionSource | null;
};

/** Stamped source, else the buyer's stored relationship with this expert, else marketplace. */
async function resolveSource(
  db: PrismaLike,
  payment: FeePayment,
  consultantProfileId: string,
): Promise<PaymentAttributionSource> {
  if (payment.attributionSource) return payment.attributionSource;
  const owned = await db.expertCustomerRelationship.findUnique({
    where: {
      consultantProfileId_buyerUserId: {
        consultantProfileId,
        buyerUserId: payment.userId,
      },
    },
    select: { source: true },
  });
  return owned?.source ?? "MARKETPLACE";
}

/** Pre-transaction estimate of the B2C platform fee (no waiver is spent here). */
export async function planB2cPlatformFeePaise(
  db: PrismaLike,
  payment: FeePayment,
  consultantProfileId: string,
  grossAmount: number,
): Promise<number> {
  const bps =
    payment.platformFeeBps ??
    feeBpsForSource(
      await readActiveFeeSchedule(db),
      await resolveSource(db, payment, consultantProfileId),
    );
  return prorate(grossAmount, bps, 10_000);
}

/**
 * The B2C platform fee for the earnings write, inside the capture transaction: a live
 * fee waiver makes it 0, otherwise the stamped bps or the active schedule's rate for the
 * sale's source. The bps actually charged is stamped back on the Payment.
 */
export async function settleB2cPlatformFeePaise(
  tx: Tx,
  payment: FeePayment,
  consultantProfileId: string,
  grossAmount: number,
  opts: { allowWaiver: boolean },
): Promise<number> {
  const source = await resolveSource(tx, payment, consultantProfileId);
  const waived =
    opts.allowWaiver && (await consumeFeeWaiver(tx, consultantProfileId));
  const bps = waived
    ? 0
    : (payment.platformFeeBps ??
      feeBpsForSource(await readActiveFeeSchedule(tx), source));
  if (bps !== payment.platformFeeBps || !payment.attributionSource) {
    await tx.payment.updateMany({
      where: { id: payment.id },
      data: { platformFeeBps: bps, attributionSource: source },
    });
  }
  return prorate(grossAmount, bps, 10_000);
}
