import { formatCurrencyAmount } from "@/utils/formatting";

/** Listing cards are viewer-agnostic, so the amount is before GST; the product page shows the buyer's total. */
export function productPriceLabel(pricePaise: number): string {
  return pricePaise === 0
    ? "Free"
    : `${formatCurrencyAmount(pricePaise, "INR")} + GST`;
}
