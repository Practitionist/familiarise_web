import { formatCurrencyAmount } from "@/utils/formatting";

/**
 * #1771 — a rupee amount typed by an operator, to integer paise, without
 * float maths: "1234.5" → 123450. More than two decimals, separators or
 * anything non-numeric answer null, so the form refuses instead of rounding.
 */
export function rupeesToPaise(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}

/**
 * The full rupee text for an amount held in paise: "₹1,23,456.78".
 * Paise are the only unit the database stores, so the conversion happens
 * here, once, at the edge of the screen.
 */
export function formatRupees(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

/**
 * The same, for an amount whose currency is not known at the call site —
 * the back office holds more than one currency, and a figure with the wrong
 * symbol on it is worse than no figure.
 */
export function formatPaise(paise: number, currency: string): string {
  return formatCurrencyAmount(paise, currency);
}

/**
 * The compact rupee text for a stat tile, in the Indian numbering a finance
 * operator reads without thinking: "₹1.20L", "₹84.5K", "₹999".
 *
 * Compact is for a headline that has a full figure next to it; a figure that
 * is the answer to a question belongs in `formatRupees`.
 */
export function formatRupeesCompact(paise: number): string {
  const rupees = paise / 100;
  const magnitude = Math.abs(rupees);
  if (magnitude >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(2)}Cr`;
  if (magnitude >= 100_000) return `₹${(rupees / 100_000).toFixed(2)}L`;
  if (magnitude >= 1_000) return `₹${(rupees / 1_000).toFixed(1)}K`;
  return `₹${rupees.toFixed(0)}`;
}
