"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import type { CheckoutInput } from "@/schemas/checkout";

const heldCreditsSchema = z.object({
  heldCreditsPaise: z.number().int().nonnegative(),
});

/** Credit the buyer's own open order for this item holds; checkout counts it as available. */
export function useOwnOpenOrderCredits(item: CheckoutInput | null): number {
  const { data } = useQuery({
    queryKey: ["checkout-own-open-order", item],
    enabled: item !== null,
    queryFn: async () => {
      const res = await fetch("/api/checkout/own-open-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to read the open order");
      return heldCreditsSchema.parse(await res.json()).heldCreditsPaise;
    },
  });
  return data ?? 0;
}
