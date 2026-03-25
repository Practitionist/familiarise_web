/**
 * Currency Validation Guards
 *
 * Ensures currency consistency across plans, discounts, credits, and payments.
 * All prices are stored in INR paise for MVP. These guards prevent
 * cross-currency mismatches that could cause incorrect charges.
 */

/**
 * Validate that a plan's price currency matches the expected charge currency.
 * For MVP: all plans must be INR.
 *
 * @throws Error if currency doesn't match
 */
export function validatePlanCurrency(
  priceCurrency: string,
  expected: string = "INR",
): void {
  if (priceCurrency !== expected) {
    throw new Error(
      `Plan currency mismatch: expected ${expected}, got ${priceCurrency}. ` +
        `Multi-currency pricing is not yet supported.`,
    );
  }
}

/**
 * Validate that a FIXED_AMOUNT discount is in the correct currency.
 * Percentage discounts are currency-agnostic and always pass.
 *
 * @returns true if valid, false if mismatch
 */
export function validateDiscountCurrency(
  discount: {
    discountType: string;
    currency?: string;
  },
  planCurrency: string,
): boolean {
  // Percentage discounts are currency-agnostic
  if (discount.discountType === "PERCENTAGE") return true;

  // FIXED_AMOUNT must match plan currency
  const discountCurrency = discount.currency || "INR";
  return discountCurrency === planCurrency;
}

/**
 * Validate that referral credits can be applied to a payment.
 * Credits must be in the same currency as the payment.
 */
export function validateCreditCurrency(
  creditCurrency: string,
  paymentCurrency: string,
): boolean {
  return creditCurrency === paymentCurrency;
}
