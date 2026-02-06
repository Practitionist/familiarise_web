import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Locale lookup for currency formatting.
 * Uses the most natural locale for each currency so numbers are grouped
 * correctly (e.g., ₹1,00,000 for INR vs $100,000 for USD).
 * Falls back to "en-US" for unlisted currencies — Intl handles the
 * currency symbol regardless of locale.
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
 * Format an amount stored in the smallest currency unit for display.
 * Converts to the major unit (e.g., paise → rupees, cents → dollars)
 * and formats with the appropriate locale for the currency.
 *
 * @param amountInSmallestUnit - Amount in smallest unit (e.g., 50000 paise = ₹500.00, 1000 cents = $10.00)
 * @param currency             - ISO 4217 currency code (default: "INR")
 */
export function formatAmountFromPaise(
  amountInSmallestUnit: number,
  currency: string = "INR",
): string {
  const locale = CURRENCY_LOCALE_MAP[currency] || "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountInSmallestUnit / 100);
}
