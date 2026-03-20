import prisma from "@/lib/prisma";
import { detectBuyerCountry, extractBuyerCountryParams } from "./buyer-country";

export interface CheckoutTaxContext {
  buyerCountry: string;
  isInternational: boolean;
}

export async function resolveCheckoutTaxContext(params: {
  userId: string;
  headers: Headers;
}): Promise<CheckoutTaxContext> {
  const userRecord = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { country: true },
  });

  const headerParams = extractBuyerCountryParams(params.headers);
  const buyerCountry = detectBuyerCountry({
    userCountry: userRecord?.country,
    ...headerParams,
  });

  return {
    buyerCountry,
    isInternational: buyerCountry !== "IN",
  };
}
