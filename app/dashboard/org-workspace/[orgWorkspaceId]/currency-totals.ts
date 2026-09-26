import type { CurrencyTotal } from "@/lib/data/org-workspace";
import { formatCurrencyAmount } from "@/utils/formatting";

/** "₹1,200.00 · $40.00" — one figure per currency, never a mixed sum (#1527). */
export function formatCurrencyTotals(totals: CurrencyTotal[]): string {
  // #1527 review — an empty list has no currency to assert; a bare zero
  // avoids implying INR for a workspace whose orgs bill in something else.
  if (totals.length === 0) return "0.00";
  return totals
    .map((t) => formatCurrencyAmount(t.paise, t.currency))
    .join(" · ");
}
