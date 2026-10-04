import type { PaymentAttributionSource } from "@prisma/client";

import type { PrismaLike } from "@/lib/prisma";
import {
  feeBpsForSource,
  readActiveFeeSchedule,
} from "@/lib/payments/pricing/platform-fee";
import { verifyExpertVia } from "./attribution-token";
import { isProgramLive, readReferralProgramConfig } from "./program-config";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WelcomeDiscount {
  bps: number;
  maxPaise: number;
}

export interface CheckoutAttribution {
  source: PaymentAttributionSource;
  /** Set only on the referee's first purchase, which carries the welcome discount. */
  referralId: string | null;
  platformFeeBps: number;
  welcomeDiscount: WelcomeDiscount | null;
  /** Credits may cover at most this share of the list price: min(programme cap, take rate). */
  creditCapBps: number;
}

export interface AttributionInput {
  buyerUserId: string;
  consultantProfileId: string | null;
  consultantUserId: string | null;
  /** The `fam_via` cookie value, verified here. */
  viaToken: string | null;
  /** WALLET / INVOICE / LICENSE funding: never a consumer-referral purchase. */
  orgFunded: boolean;
  hasDiscountCode: boolean;
  now?: Date;
}

async function resolveSource(
  db: PrismaLike,
  input: AttributionInput,
  windowDays: number | null,
  now: Date,
): Promise<{ source: PaymentAttributionSource; referralId: string | null }> {
  const marketplace = { source: "MARKETPLACE" as const, referralId: null };
  const { buyerUserId, consultantProfileId, consultantUserId } = input;
  if (!consultantProfileId || consultantUserId === buyerUserId) {
    return marketplace;
  }

  const owned = await db.expertCustomerRelationship.findUnique({
    where: {
      consultantProfileId_buyerUserId: { consultantProfileId, buyerUserId },
    },
    select: { source: true },
  });
  if (owned) return { source: owned.source, referralId: null };

  if (verifyExpertVia(input.viaToken) === consultantProfileId) {
    return { source: "OWN_LINK", referralId: null };
  }

  if (input.orgFunded || windowDays === null) return marketplace;
  const referral = await db.referral.findFirst({
    where: {
      referredUserId: buyerUserId,
      status: "SIGNED_UP",
      signedUpAt: { gte: new Date(now.getTime() - windowDays * DAY_MS) },
    },
    select: { id: true, referralCode: { select: { userId: true } } },
  });
  if (!referral || referral.referralCode.userId === consultantUserId) {
    return marketplace;
  }
  const priorPaid = await db.payment.count({
    where: { userId: buyerUserId, paymentStatus: "SUCCEEDED", deletedAt: null },
  });
  return priorPaid === 0
    ? { source: "CONSUMER_REFERRAL", referralId: referral.id }
    : marketplace;
}

/**
 * Who brought this sale and what follows from it: the take rate, the referee's
 * welcome discount (first marketplace purchase only, never with a discount code) and
 * the credit-redemption cap.
 */
export async function resolveCheckoutAttribution(
  db: PrismaLike,
  input: AttributionInput,
): Promise<CheckoutAttribution> {
  const now = input.now ?? new Date();
  const schedule = await readActiveFeeSchedule(db, now);
  const cfg = await readReferralProgramConfig(db);
  const live = isProgramLive(cfg);
  const { source, referralId } = await resolveSource(
    db,
    input,
    live ? cfg.qualifyWindowDays : null,
    now,
  );
  const platformFeeBps = feeBpsForSource(schedule, source);
  const welcomeDiscount =
    live && referralId && !input.hasDiscountCode && cfg.discountBps > 0
      ? { bps: cfg.discountBps, maxPaise: cfg.discountMaxPaise }
      : null;
  return {
    source,
    referralId,
    platformFeeBps,
    welcomeDiscount,
    creditCapBps: Math.min(
      cfg?.redemptionCapBps ?? platformFeeBps,
      platformFeeBps,
    ),
  };
}
