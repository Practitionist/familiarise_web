import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format an amount stored in paise (smallest currency unit) for display.
 * Converts to the major unit (e.g., paise → rupees) and formats with
 * the Indian locale for INR.
 *
 * @param amountInPaise - Amount in smallest unit (e.g., 50000 = ₹500.00)
 * @param currency      - ISO 4217 currency code (default: "INR")
 */
export function formatAmountFromPaise(
  amountInPaise: number,
  currency: string = "INR",
): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountInPaise / 100);
}
