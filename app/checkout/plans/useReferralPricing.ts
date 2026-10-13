"use client";

import { useQuery } from "@tanstack/react-query";

import {
  referralPricingSchema,
  type ReferralPricing,
} from "@/lib/referrals/promo-math";

/** Null until loaded, and on failure: the preview then shows no welcome discount and no credits. */
export function useReferralPricing(
  consultantProfileId: string | null | undefined,
): ReferralPricing | null {
  const { data } = useQuery({
    queryKey: ["checkout-referral-pricing", consultantProfileId],
    enabled: !!consultantProfileId,
    queryFn: async () => {
      const res = await fetch(
        `/api/checkout/referral-pricing?consultantProfileId=${encodeURIComponent(consultantProfileId ?? "")}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("Failed to load referral pricing");
      return referralPricingSchema.parse(await res.json());
    },
  });
  return data ?? null;
}
