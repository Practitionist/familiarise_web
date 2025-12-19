/**
 * Checkout Math Utilities
 *
 * These functions handle pricing calculations for checkout.
 * Tax rates and discount logic should be configured per region/business rules.
 */

// Default tax rate (can be overridden via env or region config)
const DEFAULT_TAX_RATE = parseFloat(process.env.NEXT_PUBLIC_CHECKOUT_TAX_RATE || "0.18"); // 18% GST default for India

export interface PricingConfig {
  taxRate?: number; // Override tax rate (0.18 = 18%)
  discountPercent?: number; // Applied discount percentage (0.10 = 10%)
  discountAmount?: number; // Fixed discount amount
}

export interface PricingBreakdown {
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  discountAmount: number;
  discountPercent: number;
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
export function calculateSubtotal(amount: number, quantity: number = 1): number {
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
  const taxRate = config.taxRate ?? DEFAULT_TAX_RATE;
  const discountPercent = config.discountPercent ?? 0;

  const subtotal = calculateSubtotal(baseAmount);
  const discountAmount = calculateDiscount(
    subtotal,
    discountPercent,
    config.discountAmount,
  );
  const netAmount = calculateNetAmount(subtotal, discountAmount);
  const taxAmount = calculateTax(netAmount, taxRate);
  const total = calculateTotal(netAmount, taxAmount);

  return {
    subtotal,
    taxAmount,
    taxRate,
    discountAmount,
    discountPercent,
    total,
  };
}

/**
 * Format currency amount for display
 */
export function formatCurrency(
  amount: number,
  currency: string = "INR",
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format percentage for display
 */
export function formatPercentage(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
