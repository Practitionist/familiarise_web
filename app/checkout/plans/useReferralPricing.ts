"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

const referralPricingSchema = z.object({
  welcomeDiscount: z
    .object({
      bps: z.number().int().min(0).max(10_000),
      maxPaise: z.number().int().nonnegative(),
    })
    .nullable(),
  creditCapBps: z.number().int().min(0).max(10_000),
});

export type ReferralPricing = z.infer<typeof referralPricingSchema>;

/** Null until loaded, and on failure: the preview then shows no welcome discount and no cap. */
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
