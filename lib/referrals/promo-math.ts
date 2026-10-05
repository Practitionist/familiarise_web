/**
 * Referral promo math shared by the checkout server, the price preview and the routes that
 * feed it. Client-safe: no Prisma, no server imports. Every promo on an order (welcome
 * discount plus credits) stays within `creditCapBps` of the list price, which never exceeds
 * that order's take rate.
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

/** Pre-tax welcome discount: `min(round(list × bps / 10 000), maxPaise, list)`. */
export function computeWelcomeDiscountPaise(
  listPaise: number,
  welcome: WelcomeDiscount | null | undefined,
): number {
  if (!welcome || welcome.bps <= 0) return 0;
  const raw = Math.round((listPaise * welcome.bps) / 10_000);
  return Math.min(raw, welcome.maxPaise, listPaise);
}

/** Credits an order may still spend: `floor(list × capBps / 10 000)` less the welcome discount. */
export function creditCapPaise(
  listPaise: number,
  capBps: number,
  welcomeDiscountPaise: number,
): number {
  const cap = Math.floor((listPaise * Math.max(0, capBps)) / 10_000);
  return Math.max(0, cap - welcomeDiscountPaise);
}

/** Whether the welcome discount survives: the cash left after credits must clear its floor. */
export function keepsWelcomeDiscount(
  welcome: WelcomeDiscount | null | undefined,
  cashPaise: number,
): boolean {
  return !!welcome && cashPaise >= welcome.minOrderPaise;
}
