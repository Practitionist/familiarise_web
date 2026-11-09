/**
 * Checkout amount derivation — the single order of operations.
 *
 * The amount a buyer is charged is the product of four stages applied in a
 * fixed order: the plan's list price, then at most one pre-tax discount (a
 * code or the welcome discount), then tax on the discounted base, then
 * referral credits against the tax-inclusive total. Every platform-funded
 * stage together stays within `platformFundedCapPaise`.
 *
 * Everything in this module is a pure function of its arguments. The one
 * concession is `resolveAvailableCreditsPaise`: the caller supplies it and it
 * is invoked only when the order actually clears the redemption floor, which
 * is what keeps the credit balance read out of the transaction's read set on
 * orders that could never spend a credit anyway.
 */

import {
  determineTax,
  type ServiceType,
  type TaxDetermination,
} from "@/lib/payments/tax/tax-engine";
import type { GstRegime } from "@/lib/payments/tax/gst-regime";
import { platformFundedCapPaise } from "@/lib/payments/pricing/platform-funded-cap";
import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";
import { prorate } from "@/lib/payments/utils/money";
import {
  computeWelcomeDiscountPaise,
  creditCapPaise,
  keepsWelcomeDiscount,
  type WelcomeDiscount,
} from "@/lib/referrals/promo-math";

/** The fields of a validated `DiscountCode` that move the price. */
export interface CheckoutDiscountInput {
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  /** Whole percent for PERCENTAGE, paise for FIXED_AMOUNT. */
  discountValue: number;
  /** Paise ceiling on a PERCENTAGE discount; null means uncapped. */
  maxDiscount?: number | null;
}

export interface DeriveCheckoutAmountInput {
  /** Plan list price in paise, before anything is applied to it. */
  basePaise: number;
  /** ISO-3166 alpha-2 of the buyer; decides the tax jurisdiction. */
  buyerCountry: string;
  /** From `currentGstRegime()`; UNREGISTERED charges no GST. */
  gstRegime: GstRegime;
  serviceType?: ServiceType;
  /** Already re-validated against the database by the caller, or null. */
  discount?: CheckoutDiscountInput | null;
  /** The referee's pre-tax welcome discount; ignored when a discount code is present. */
  welcomeDiscount?: WelcomeDiscount | null;
  /** Promo (welcome discount plus credits) may cover at most this many bps of the list price; absent means no credits. */
  creditCapBps?: number;
  /** The take that funds platform promo (`CheckoutAttribution.promoFeeBps`); absent means no platform-funded promo. */
  promoFeeBps?: number;
  /** Whether the buyer asked to spend referral credits on this order. */
  useReferralCredits?: boolean;
  /**
   * Redeemable credit balance in paise. Called at most once, and only when the
   * tax-inclusive total clears `MIN_CREDIT_REDEMPTION_PAISE`.
   */
  resolveAvailableCreditsPaise?: () => number | Promise<number>;
}

export interface DerivedCheckoutAmount {
  /** List price before discount, tax or credits — the consultant's earnings base. */
  originalAmount: number;
  /** Paise actually taken off the list price. */
  discountPaise: number;
  /** The part of `discountPaise` that is the referee's welcome discount. */
  welcomeDiscountPaise: number;
  /** List price minus the discount, the base tax is charged on. */
  discountedAmount: number;
  taxAmount: number;
  taxRate: number;
  isZeroRated: boolean;
  /** Discounted base plus tax — what credits are applied against. */
  taxedAmount: number;
  creditsApplied: number;
  /** What the buyer is charged. */
  amount: number;
  isInternational: boolean;
  gstRegime: GstRegime;
  /** The profitability floor this order's platform-funded promo was held to. */
  platformFundedCapPaise: number;
  tax: TaxDetermination;
}

/**
 * Paise taken off `basePaise` by `discount`.
 *
 * A FIXED_AMOUNT discount never drives the price below zero; a PERCENTAGE one
 * cannot, because the value is constrained to 1–100 below.
 */
export function computeDiscountPaise(
  basePaise: number,
  discount: CheckoutDiscountInput | null | undefined,
): number {
  if (!discount) return 0;

  // A negative value or cap would RAISE the price above the list price.
  if (
    discount.discountValue < 0 ||
    (discount.maxDiscount !== null &&
      discount.maxDiscount !== undefined &&
      discount.maxDiscount < 0)
  ) {
    throw new Error(
      `Invalid discount code: negative value or cap (${discount.discountValue}, ${discount.maxDiscount ?? "no cap"})`,
    );
  }

  if (discount.discountType === "PERCENTAGE") {
    // Data-integrity check on the stored code, not on user input.
    if (discount.discountValue < 1 || discount.discountValue > 100) {
      throw new Error(
        `Invalid discount code: percentage value must be between 1 and 100, got ${discount.discountValue}`,
      );
    }
    const raw = prorate(basePaise, discount.discountValue, 100, "round");
    const cap = discount.maxDiscount;
    return cap !== null && cap !== undefined && raw > cap ? cap : raw;
  }

  if (discount.discountType === "FIXED_AMOUNT") {
    return Math.min(basePaise, discount.discountValue);
  }

  return 0;
}

/**
 * Whether an order of `taxedAmount` paise may spend referral credits: only at
 * or above the floor, so a credit never exceeds the value of the booking.
 */
export function isCreditRedemptionEligible(taxedAmount: number): boolean {
  return taxedAmount >= MIN_CREDIT_REDEMPTION_PAISE;
}

/**
 * The full derivation. Async only because the credit balance is resolved by a
 * caller-supplied callback; with a plain number (or nothing) it settles
 * synchronously and reads as the pure calculation it is.
 */
export async function deriveCheckoutAmount(
  input: DeriveCheckoutAmountInput,
): Promise<DerivedCheckoutAmount> {
  const originalAmount = input.basePaise;
  const gstRegistered = input.gstRegime === "REGISTERED";
  const promoCapPaise = platformFundedCapPaise({
    listPaise: originalAmount,
    platformFeeBps: input.promoFeeBps ?? 0,
    gstRegistered,
  });
  const codeDiscountPaise = Math.min(
    computeDiscountPaise(originalAmount, input.discount),
    promoCapPaise,
  );
  const isInternational = input.buyerCountry !== "IN";

  let balance: Promise<number> | null = null;
  const availableCredits = () => {
    balance ??= Promise.resolve(input.resolveAvailableCreditsPaise?.() ?? 0);
    return balance;
  };

  const price = async (welcomeDiscountPaise: number) => {
    const discountPaise = codeDiscountPaise + welcomeDiscountPaise;
    const discountedAmount = originalAmount - discountPaise;
    const tax = determineTax({
      baseAmountPaise: discountedAmount,
      buyerCountry: input.buyerCountry,
      serviceType: input.serviceType ?? "CONSULTING",
      gstRegistered,
    });
    const taxedAmount = discountedAmount + tax.taxAmount;
    let creditsApplied = 0;
    if (
      input.useReferralCredits === true &&
      isCreditRedemptionEligible(taxedAmount) &&
      input.resolveAvailableCreditsPaise
    ) {
      const totalAvailable = await availableCredits();
      if (totalAvailable > 0) {
        creditsApplied = Math.min(
          totalAvailable,
          taxedAmount,
          creditCapPaise(
            originalAmount,
            input.creditCapBps ?? 0,
            welcomeDiscountPaise,
            promoCapPaise - discountPaise,
          ),
        );
      }
    }
    return {
      originalAmount,
      discountPaise,
      welcomeDiscountPaise,
      discountedAmount,
      taxAmount: tax.taxAmount,
      taxRate: tax.taxRate,
      isZeroRated: tax.isZeroRated,
      taxedAmount,
      creditsApplied,
      amount: taxedAmount - creditsApplied,
      isInternational,
      gstRegime: input.gstRegime,
      platformFundedCapPaise: promoCapPaise,
      tax,
    };
  };

  const welcome = input.discount ? null : input.welcomeDiscount;
  const welcomePaise = computeWelcomeDiscountPaise(
    originalAmount,
    welcome,
    promoCapPaise,
  );
  if (welcomePaise === 0) return price(0);
  const withWelcome = await price(welcomePaise);
  return keepsWelcomeDiscount(welcome, withWelcome.amount)
    ? withWelcome
    : price(0);
}
