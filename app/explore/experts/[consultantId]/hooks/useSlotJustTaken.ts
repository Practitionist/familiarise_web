"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { SLOT_JUST_TAKEN_MESSAGE } from "@/lib/errors/mapping/payment-error-toast-map";
import { invalidateAvailability } from "./useAvailabilityWindow";

/**
 * Refetches the expert's grid, says the time was taken, and returns the buyer to the grid;
 * `?conflict=1` makes the grid's next read skip the browser cache.
 */
export function useSlotJustTaken(consultantProfileId: string | undefined) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  return useCallback(() => {
    void invalidateAvailability(queryClient, consultantProfileId);
    toast({ title: SLOT_JUST_TAKEN_MESSAGE, variant: "destructive" });
    if (consultantProfileId) {
      router.push(`/explore/experts/${consultantProfileId}?conflict=1`);
    }
  }, [queryClient, consultantProfileId, router, toast]);
}
