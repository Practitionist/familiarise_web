import {
  deriveCheckoutAmount,
  type DerivedCheckoutAmount,
} from "@/lib/payments/pricing/derive-checkout-amount";

/** The charge for one digital product sale; the detail page and the order mint share it. */
export function deriveDigitalProductAmount(params: {
  pricePaise: number;
  buyerCountry: string;
}): Promise<DerivedCheckoutAmount> {
  return deriveCheckoutAmount({
    basePaise: params.pricePaise,
    buyerCountry: params.buyerCountry,
  });
}
