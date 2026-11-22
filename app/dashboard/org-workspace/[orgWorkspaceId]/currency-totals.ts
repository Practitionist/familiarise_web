import type { CurrencyTotal } from "@/lib/data/org-workspace";
import { formatCurrencyAmount } from "@/utils/formatting";

/** "₹1,200.00 · $40.00" — one figure per currency, never a mixed sum (#1527). */
export function formatCurrencyTotals(totals: CurrencyTotal[]): string {
  // No active organisation, so no currency to name: a dash, never an assumed ₹.
  if (totals.length === 0) return "—";
  return totals
    .map((t) => formatCurrencyAmount(t.paise, t.currency))
    .join(" · ");
}
