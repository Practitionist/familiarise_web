"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { invalidateAvailability } from "@/lib/scheduling/use-availability-window";

/**
 * The expert's page with the plan's time picker open. `?conflict=1` makes the
 * grid's next read skip the browser cache; `plan` names the picker to open.
 */
export function chooseAnotherTimeHref(
  consultantProfileId: string,
  planId: string | undefined,
): string {
  const params = new URLSearchParams({ conflict: "1" });
  if (planId) params.set("plan", planId);
  return `/explore/experts/${consultantProfileId}?${params.toString()}`;
}

export interface ChooseAnotherTimeNotice {
  title: string;
  description?: string | null;
}

/**
 * Refetches the expert's grid, says why the chosen time cannot be bought, and
 * returns the buyer to the same plan's picker.
 */
export function useChooseAnotherTime(
  consultantProfileId: string | undefined,
  planId: string | undefined,
) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  return useCallback(
    (notice: ChooseAnotherTimeNotice) => {
      void invalidateAvailability(queryClient, consultantProfileId);
      toast({
        title: notice.title,
        ...(notice.description ? { description: notice.description } : {}),
        variant: "destructive",
      });
      if (consultantProfileId) {
        router.push(chooseAnotherTimeHref(consultantProfileId, planId));
      }
    },
    [queryClient, consultantProfileId, planId, router, toast],
  );
}
