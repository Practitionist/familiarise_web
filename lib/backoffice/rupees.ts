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
