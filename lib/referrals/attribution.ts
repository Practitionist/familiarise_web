import type { PaymentAttributionSource } from "@prisma/client";

import type { PrismaLike } from "@/lib/prisma";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import {
  feeBpsForSource,
  liveFeeWaiverWhere,
  readActiveFeeSchedule,
} from "@/lib/payments/pricing/platform-fee";
import { verifyExpertVia } from "./attribution-token";
import type { WelcomeDiscount } from "./promo-math";
import { isProgramLive, readReferralProgramConfig } from "./program-config";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The partial unique holding one live welcome-discounted order per buyer. */
const WELCOME_DISCOUNT_SLOT = "Payment_live_welcome_discount_user_key";

/**
 * A second live welcome-discounted order becomes the typed 409 WELCOME_DISCOUNT_IN_USE (the
 * buyer finishes or abandons the open one); any other error passes through unchanged.
 */
export function asWelcomeDiscountConflict(err: unknown): unknown {
  if (!isUniqueViolationOn(err, WELCOME_DISCOUNT_SLOT)) return err;
  return Object.assign(
    new Error(
      "WELCOME_DISCOUNT_IN_USE: another open order already carries this buyer's welcome discount",
    ),
    { httpStatus: 409, code: "WELCOME_DISCOUNT_IN_USE" },
  );
}

export interface CheckoutAttribution {
  source: PaymentAttributionSource;
  /** Set only on a referee's first purchase inside the window, which may carry the welcome discount. */
  referralId: string | null;
  platformFeeBps: number;
  welcomeDiscount: WelcomeDiscount | null;
  /** Promo may cover at most this share of the list price: min(programme cap, take rate). */
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
    where: {
      userId: buyerUserId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      referralReleasedAt: null,
    },
  });
  return priorPaid === 0
    ? { source: "CONSUMER_REFERRAL", referralId: referral.id }
    : marketplace;
}

/**
 * Orders whose take may not fund promo: a live fee waiver will zero it at capture, and a
 * host-org seller's take is set by the org rate card rather than the stamped bps.
 */
async function takeCannotFundPromo(
  db: PrismaLike,
  consultantProfileId: string | null,
  now: Date,
): Promise<boolean> {
  if (!consultantProfileId) return false;
  const waiver = await db.consultantFeeWaiver.findFirst({
    where: liveFeeWaiverWhere(consultantProfileId, now),
    select: { id: true },
  });
  if (waiver) return true;
  if (!ENABLE_HOST_ORGS) return false;
  const hostMembership = await db.membership.findFirst({
    where: {
      consultantProfileId,
      role: "EXPERT",
      status: "ACTIVE",
      organization: { canHost: true, status: "ACTIVE" },
    },
    select: { id: true },
  });
  return hostMembership !== null;
}

/**
 * Who brought this sale and what follows from it: the take rate, the referee's
 * welcome discount (first marketplace purchase only, never with a discount code) and
 * the promo cap. Promo never exceeds the order's take.
 */
export async function resolveCheckoutAttribution(
  db: PrismaLike,
  input: AttributionInput,
): Promise<CheckoutAttribution> {
  const now = input.now ?? new Date();
  const schedule = await readActiveFeeSchedule(db, now);
  const cfg = await readReferralProgramConfig(db);
  // The 90% pause stops new sign-ups only; a referee already SIGNED_UP keeps the discount.
  const { source, referralId } = await resolveSource(
    db,
    input,
    isProgramLive(cfg) ? cfg.qualifyWindowDays : null,
    now,
  );
  const platformFeeBps = feeBpsForSource(schedule, source);
  if (await takeCannotFundPromo(db, input.consultantProfileId, now)) {
    return {
      source,
      referralId,
      platformFeeBps,
      welcomeDiscount: null,
      creditCapBps: 0,
    };
  }
  const welcomeBps = Math.min(cfg?.discountBps ?? 0, platformFeeBps);
  const welcomeDiscount: WelcomeDiscount | null =
    isProgramLive(cfg) && referralId && !input.hasDiscountCode && welcomeBps > 0
      ? {
          bps: welcomeBps,
          maxPaise: cfg.discountMaxPaise,
          minOrderPaise: cfg.minOrderPaise,
        }
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
