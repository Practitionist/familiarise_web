import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";
import { prorate } from "@/lib/payments/utils/money";
import { formatCurrencyAmount } from "@/utils/formatting";

/** The suffix shown beside a buyer price once the platform is GST-registered. */
export const GST_INCLUSIVE_LABEL = "incl. GST";

/**
 * What a domestic buyer sees as the price. While the platform is unregistered
 * the list price is the all-in price; once registered it is the list price plus
 * 18% GST, rounded exactly as `determineTax` rounds the charge.
 */
export function buyerDisplayPricePaise(
  listPricePaise: number,
  gstRegistered: boolean,
): number {
  if (!gstRegistered || listPricePaise <= 0) return listPricePaise;
  return (
    listPricePaise +
    prorate(listPricePaise, TAX_CONSTANTS.GST_RATE, 100, "round")
  );
}

/** The GST note for a priced item, or null when nothing should be said. */
export function buyerPriceNote(
  listPricePaise: number,
  gstRegistered: boolean,
): string | null {
  return gstRegistered && listPricePaise > 0 ? GST_INCLUSIVE_LABEL : null;
}

/** Appends the GST note to an already-formatted price ("₹1,180" -> "₹1,180 incl. GST"). */
export function withBuyerPriceNote(
  formatted: string,
  listPricePaise: number,
  gstRegistered: boolean,
): string {
  const note = buyerPriceNote(listPricePaise, gstRegistered);
  return note ? `${formatted} ${note}` : formatted;
}

/** For server-rendered listings: the all-in INR price with its GST note. */
export function buyerPriceLabelInr(
  listPricePaise: number,
  gstRegistered: boolean,
): string {
  return withBuyerPriceNote(
    formatCurrencyAmount(
      buyerDisplayPricePaise(listPricePaise, gstRegistered),
      "INR",
    ),
    listPricePaise,
    gstRegistered,
  );
}
