import { buyerPriceLabelInr } from "@/lib/payments/pricing/display-price";

/** Listing cards show the all-in price once the platform is GST-registered. */
export function productPriceLabel(
  pricePaise: number,
  gstRegistered: boolean,
): string {
  return pricePaise === 0
    ? "Free"
    : buyerPriceLabelInr(pricePaise, gstRegistered);
}
