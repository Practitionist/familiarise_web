"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { parseJsonResponse } from "@/lib/fetch-helpers";
import { viewerPlanClientSchema } from "@/schemas/plan-clients";

const viewerPlanClientResponseSchema = z.object({
  data: viewerPlanClientSchema,
});

/**
 * Whether the plan buy action is turned away for this viewer: the cached page
 * says the expert is fully booked, and the viewer holds none of their plans.
 */
export function usePlanBuyBlocked(
  consultantProfileId: string,
  planClientsFull: boolean,
  viewerUserId: string | undefined,
): boolean {
  const viewer = useQuery({
    queryKey: ["viewer-plan-client", consultantProfileId, viewerUserId],
    enabled: planClientsFull && !!viewerUserId,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(
        `/api/consultants/${consultantProfileId}/plan-client`,
        { cache: "no-store" },
      );
      const body = await parseJsonResponse(
        res,
        viewerPlanClientResponseSchema,
        "Couldn't check your plans with this expert",
      );
      return body.data;
    },
  });
  return planClientsFull && viewer.data?.holdsPlan !== true;
}
