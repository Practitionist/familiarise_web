/**
 * Referral promo math shared by the checkout server, the price preview and the routes that
 * feed it. Client-safe: no Prisma, no server imports. The welcome discount plus credits stay
 * within `creditCapBps` of the list price, and all platform-funded promo on an order stays
 * within `platformFundedCapPaise` (lib/payments/pricing/platform-funded-cap.ts).
 */
import { z } from "zod";

const bps = z.number().int().min(0).max(10_000);
const paise = z.number().int().nonnegative();

export const welcomeDiscountSchema = z.object({
  bps,
  maxPaise: paise,
  /** The discount is kept only when the cash still paid after it clears this floor. */
  minOrderPaise: paise,
});

export type WelcomeDiscount = z.infer<typeof welcomeDiscountSchema>;

/** `GET /api/checkout/referral-pricing`: what checkout will apply for this buyer and expert. */
export const referralPricingSchema = z.object({
  welcomeDiscount: welcomeDiscountSchema.nullable(),
  creditCapBps: bps,
  /** The take that can fund platform promo on this order; 0 on a fee-waiver or host-org order. */
  promoFeeBps: bps,
});

export type ReferralPricing = z.infer<typeof referralPricingSchema>;

/** The programme as buyers see it; the referral-code routes send it, null while it is off. */
export const referralTermsSchema = z.object({
  discountPercent: z.number().min(0).max(100),
  discountMaxPaise: paise,
  referrerRewardPaise: paise,
  minOrderPaise: paise,
  redemptionCapPercent: z.number().min(0).max(100),
  qualifyWindowDays: z.number().int().positive(),
  expertWaiverSessions: z.number().int().nonnegative(),
});

export type ReferralTerms = z.infer<typeof referralTermsSchema>;

/** What a referred friend is promised, including the payable-after-discount floor and that a low-priced session can earn less. */
export function welcomeOfferText(
  terms: Pick<
    ReferralTerms,
    "discountPercent" | "discountMaxPaise" | "minOrderPaise"
  >,
  formatAmount: (paise: number) => string,
): string {
  const floor =
    terms.minOrderPaise > 0
      ? `, if you still pay at least ${formatAmount(terms.minOrderPaise)} after the discount`
      : "";
  return `${terms.discountPercent}% off your first booking, up to ${formatAmount(terms.discountMaxPaise)}${floor}, and it may be lower on low-priced sessions`;
}

/** Pre-tax welcome discount: `min(round(list × bps / 10 000), maxPaise, list, platform-funded cap)`. */
export function computeWelcomeDiscountPaise(
  listPaise: number,
  welcome: WelcomeDiscount | null | undefined,
  platformFundedCapPaise: number,
): number {
  if (!welcome || welcome.bps <= 0) return 0;
  const raw = Math.round((listPaise * welcome.bps) / 10_000);
  return Math.max(
    0,
    Math.min(raw, welcome.maxPaise, listPaise, platformFundedCapPaise),
  );
}

/**
 * Credits an order may still spend: `floor(list × capBps / 10 000)` less the welcome
 * discount, and never more than the platform-funded cap the discounts left over.
 */
export function creditCapPaise(
  listPaise: number,
  capBps: number,
  welcomeDiscountPaise: number,
  platformFundedLeftPaise: number,
): number {
  const cap = Math.floor((listPaise * Math.max(0, capBps)) / 10_000);
  return Math.max(
    0,
    Math.min(cap - welcomeDiscountPaise, platformFundedLeftPaise),
  );
}

/** Whether the welcome discount survives: the cash left after credits must clear its floor. */
export function keepsWelcomeDiscount(
  welcome: WelcomeDiscount | null | undefined,
  cashPaise: number,
): boolean {
  return !!welcome && cashPaise >= welcome.minOrderPaise;
}
