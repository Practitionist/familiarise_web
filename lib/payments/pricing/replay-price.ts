import {
  deriveCheckoutAmount,
  type DerivedCheckoutAmount,
} from "@/lib/payments/pricing/derive-checkout-amount";
import { currentGstRegime } from "@/lib/payments/tax/gst-regime";

/**
 * The charge for one replay sale. Listings are webinar/class recordings, so the
 * supply is taxed as education; the detail page and the order mint share this.
 */
export function deriveReplayAmount(params: {
  listPricePaise: number;
  buyerCountry: string;
}): Promise<DerivedCheckoutAmount> {
  return deriveCheckoutAmount({
    basePaise: params.listPricePaise,
    buyerCountry: params.buyerCountry,
    gstRegime: currentGstRegime(),
    serviceType: "EDUCATION",
  });
}
