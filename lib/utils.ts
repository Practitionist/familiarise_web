import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Locale lookup for currency formatting.
 * Uses the most natural locale for each currency so numbers are grouped
 * correctly (e.g., ₹1,00,000 for INR vs $100,000 for USD).
 * Falls back to "en-IN" for unlisted currencies since 90%+ of our
 * users are Indian — Intl handles the currency symbol regardless of locale.
 */
const CURRENCY_LOCALE_MAP: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  EUR: "de-DE",
  GBP: "en-GB",
  AUD: "en-AU",
  CAD: "en-CA",
  SGD: "en-SG",
  AED: "ar-AE",
  JPY: "ja-JP",
  BRL: "pt-BR",
  CNY: "zh-CN",
  KRW: "ko-KR",
};

/**
 * ISO 4217 zero-decimal currencies.
 * These currencies have no fractional subunits — the stored amount IS
 * the major unit (e.g., ¥100 is stored as 100, not 10000).
 * Stripe and Razorpay follow this convention.
 *
 * @see https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/**
 * ISO 4217 three-decimal currencies.
 * These currencies have 1000 subunits per major unit
 * (e.g., 1 KWD = 1000 fils, stored as 1000).
 */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "KWD", "OMR"]);

/**
 * Get the divisor to convert from smallest currency unit to major unit.
 * Most currencies: 100 (cents → dollars, paise → rupees)
 * Zero-decimal:    1   (yen is yen)
 * Three-decimal:   1000 (fils → dinars)
 */
function getCurrencyDivisor(currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 1000;
  return 100;
}

/**
 * Format an amount stored in the smallest currency unit for display.
 * Automatically handles currency-specific subunit conversion using
 * ISO 4217 decimal rules (zero-decimal, two-decimal, three-decimal).
 *
 * @param amountInSmallestUnit - Amount in smallest unit (e.g., 50000 paise = ₹500.00, 1000 cents = $10.00, 500 yen = ¥500)
 * @param currency             - ISO 4217 currency code (required)
 *
 * @example
 * formatCurrencyAmount(50000, "INR") // "₹500.00"
 * formatCurrencyAmount(1000, "USD")  // "$10.00"
 * formatCurrencyAmount(500, "JPY")   // "¥500"
 * formatCurrencyAmount(1500, "KWD")  // "KD 1.500"
 */
export function formatCurrencyAmount(
  amountInSmallestUnit: number,
  currency: string,
): string {
  const upper = currency.toUpperCase();
  const locale = CURRENCY_LOCALE_MAP[upper] || "en-IN";
  const divisor = getCurrencyDivisor(upper);
  const fractionDigits = ZERO_DECIMAL_CURRENCIES.has(upper)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(upper)
      ? 3
      : 2;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: upper,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountInSmallestUnit / divisor);
}