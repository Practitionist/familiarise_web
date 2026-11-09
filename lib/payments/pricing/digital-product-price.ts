import prisma from "@/lib/prisma";
import {
  deriveCheckoutAmount,
  type DerivedCheckoutAmount,
} from "@/lib/payments/pricing/derive-checkout-amount";
import { detectBuyerCountry } from "@/lib/payments/tax/buyer-country";
import { currentGstRegime } from "@/lib/payments/tax/gst-regime";

/**
 * What this buyer is charged for one digital product sale, from the country
 * signal the order mint uses; the product page and the purchase route share it.
 */
export async function deriveDigitalProductChargeForBuyer(params: {
  pricePaise: number;
  buyerId: string | null;
}): Promise<{ buyerCountry: string; derived: DerivedCheckoutAmount }> {
  const buyer = params.buyerId
    ? await prisma.user.findUnique({
        where: { id: params.buyerId },
        select: { country: true },
      })
    : null;
  const buyerCountry = detectBuyerCountry({ userCountry: buyer?.country });
  const derived = await deriveCheckoutAmount({
    basePaise: params.pricePaise,
    buyerCountry,
    gstRegime: currentGstRegime(),
  });
  return { buyerCountry, derived };
}

export interface DigitalProductQuote {
  /** Null on a resumed order, whose split was fixed when it was minted. */
  basePaise: number | null;
  taxPaise: number | null;
  totalPaise: number;
}

/**
 * The amount the purchase route would charge this viewer next: the persisted
 * amount of their unfinished order, which the route resumes, or a fresh derivation.
 */
export async function quoteDigitalProductForBuyer(params: {
  productId: string;
  pricePaise: number;
  buyerId: string | null;
}): Promise<DigitalProductQuote> {
  const { productId, buyerId } = params;
  const pending = buyerId
    ? await prisma.digitalProductPurchase.findFirst({
        where: { productId, buyerId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: { amountPaise: true, gatewayOrderId: true },
      })
    : null;
  if (pending?.gatewayOrderId) {
    return { basePaise: null, taxPaise: null, totalPaise: pending.amountPaise };
  }
  const { derived } = await deriveDigitalProductChargeForBuyer(params);
  return {
    basePaise: derived.originalAmount,
    taxPaise: derived.taxAmount,
    totalPaise: derived.amount,
  };
}
