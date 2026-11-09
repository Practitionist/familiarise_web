import type { AppliedDiscount } from "@/types/checkout";
/**
 * Checkout Math Utilities
 *
 * These functions handle pricing calculations for checkout.
 * Tax rates and discount logic should be configured per region/business rules.
 */

import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";
import { platformFundedCapPaise } from "@/lib/payments/pricing/platform-funded-cap";
import {
  computeWelcomeDiscountPaise,
  creditCapPaise,
  keepsWelcomeDiscount,
  type WelcomeDiscount,
} from "@/lib/referrals/promo-math";

const DEFAULT_TAX_RATE = 0.18; // 18% GST for India

export interface PricingConfig {
  taxRate?: number; // Override tax rate (0.18 = 18%)
  isInternational?: boolean; // Legacy signal; zero-rating now keys off exportZeroRated
  exportZeroRated?: boolean; // Server-decided (#1230): international AND valid platform LUT
  /** Server-decided from PLATFORM_GSTIN; false charges no GST. Absent reads as registered. */
  gstRegistered?: boolean;
  discountPercent?: number; // Applied discount percentage (0.10 = 10%)
  discountAmount?: number; // Fixed discount amount
  creditsApplied?: number; // Referral credits applied (same unit as baseAmount, typically paise)
  /** Referee's pre-tax welcome discount; only used when no other discount applies. */
  welcomeDiscount?: WelcomeDiscount | null;
  /** Promo may cover at most this many bps of the list price; absent means no credits. */
  creditCapBps?: number;
  /** The take that funds platform promo (`ReferralPricing.promoFeeBps`); absent (not loaded) shows no welcome or credits. */
  promoFeeBps?: number;
}

export interface PricingBreakdown {
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  discountAmount: number;
  discountPercent: number;
  creditsApplied: number;
  total: number;
}

/**
 * Calculate tax amount based on subtotal and tax rate
 * @param amount - Base amount before tax
 * @param taxRate - Tax rate as decimal (e.g., 0.18 for 18%)
 */
export function calculateTax(
  amount: number,
  taxRate: number = DEFAULT_TAX_RATE,
): number {
  return Math.round(amount * taxRate * 100) / 100;
}

/**
 * Calculate discount amount
 * @param amount - Base amount
 * @param discountPercent - Discount percentage as decimal (e.g., 0.10 for 10%)
 * @param discountAmount - Fixed discount amount (takes precedence if provided)
 */
export function calculateDiscount(
  amount: number,
  discountPercent: number = 0,
  discountAmount?: number,
): number {
  if (discountAmount !== undefined && discountAmount > 0) {
    return Math.min(discountAmount, amount); // Can't discount more than the amount
  }
  return Math.round(amount * discountPercent * 100) / 100;
}

/**
 * Calculate subtotal (before tax and discounts)
 * For now, this is the base amount, but can include quantity logic later
 */
export function calculateSubtotal(
  amount: number,
  quantity: number = 1,
): number {
  return Math.round(amount * quantity * 100) / 100;
}

/**
 * Calculate net amount after discount but before tax
 */
export function calculateNetAmount(
  subtotal: number,
  discountAmount: number,
): number {
  return Math.round((subtotal - discountAmount) * 100) / 100;
}

/**
 * Calculate final total (net amount + tax)
 */
export function calculateTotal(netAmount: number, taxAmount: number): number {
  return Math.round((netAmount + taxAmount) * 100) / 100;
}

/**
 * Calculate complete pricing breakdown
 * This is the main function checkout pages should use
 */
export function calculatePricing(
  baseAmount: number,
  config: PricingConfig = {},
): PricingBreakdown {
  // #1230 — zero-rating is a server-decided flag (platform LUT state), not a
  // country comparison; the checkout context ships `exportZeroRated` so the
  // client preview cannot diverge from determineTax/gst.ts.
  const taxRate =
    config.exportZeroRated === true || config.gstRegistered === false
      ? 0
      : (config.taxRate ?? DEFAULT_TAX_RATE);
  const discountPercent = config.discountPercent ?? 0;

  const subtotal = calculateSubtotal(baseAmount);
  // The same profitability floor the server charges under. Until referral pricing
  // loads, the code keeps its server-capped amount and welcome and credits show none.
  const loadedCap =
    config.promoFeeBps === undefined
      ? null
      : platformFundedCapPaise({
          listPaise: Math.round(subtotal),
          platformFeeBps: config.promoFeeBps,
          gstRegistered: config.gstRegistered !== false,
        });
  const codeDiscount = Math.min(
    calculateDiscount(subtotal, discountPercent, config.discountAmount),
    loadedCap ?? Number.POSITIVE_INFINITY,
  );
  const promoCap = loadedCap ?? codeDiscount;
  const welcome = codeDiscount > 0 ? null : config.welcomeDiscount;

  const price = (welcomePaise: number) => {
    const discountAmount = codeDiscount + welcomePaise;
    const netAmount = calculateNetAmount(subtotal, discountAmount);
    const taxAmount = calculateTax(netAmount, taxRate);
    const totalBeforeCredits = calculateTotal(netAmount, taxAmount);
    // #1592 S-P1-04 — the same ₹500 redemption floor the server applies in
    // lib/payments/pricing/derive-checkout-amount.ts, so the preview never
    // shows a credit the charge will not honour.
    const creditsApplied =
      totalBeforeCredits >= MIN_CREDIT_REDEMPTION_PAISE
        ? Math.min(
            config.creditsApplied ?? 0,
            totalBeforeCredits,
            creditCapPaise(
              subtotal,
              config.creditCapBps ?? 0,
              welcomePaise,
              promoCap - discountAmount,
            ),
          )
        : 0;
    const total = Math.round((totalBeforeCredits - creditsApplied) * 100) / 100;
    return { discountAmount, taxAmount, creditsApplied, total };
  };

  const welcomePaise = computeWelcomeDiscountPaise(subtotal, welcome, promoCap);
  const withWelcome = price(welcomePaise);
  const { discountAmount, taxAmount, creditsApplied, total } =
    welcomePaise > 0 && !keepsWelcomeDiscount(welcome, withWelcome.total)
      ? price(0)
      : withWelcome;

  return {
    subtotal,
    taxAmount,
    taxRate,
    discountAmount,
    discountPercent,
    creditsApplied,
    total,
  };
}

/**
 * Format percentage for display
 */
export function formatPercentage(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/**
 * The applied-code chip text: the amount this booking actually takes off. The
 * server caps a platform code at the profitability floor, so the code's face
 * value can be larger than the discount.
 */
export function appliedDiscountLabel(
  discount: AppliedDiscount,
  formatPrice: (paise: number) => string,
): { label: string; limited: boolean } {
  if (discount.discountAmount !== undefined) {
    const nominal =
      discount.discountType === "FIXED_AMOUNT" ? discount.discountValue : null;
    return {
      label: `${formatPrice(discount.discountAmount)} off`,
      limited: nominal !== null && discount.discountAmount < nominal,
    };
  }
  return {
    label:
      discount.discountType === "PERCENTAGE"
        ? `${discount.discountValue}% off`
        : `${formatPrice(discount.discountValue)} off`,
    limited: false,
  };
}
