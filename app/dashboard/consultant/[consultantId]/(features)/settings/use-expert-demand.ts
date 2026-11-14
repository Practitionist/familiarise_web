"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { parseJsonResponse } from "@/lib/fetch-helpers";
import { expertDemandSchema } from "@/schemas/expert-demand";

const demandResponseSchema = z.object({ data: expertDemandSchema });

export const expertDemandQueryKey = (consultantId: string) =>
  ["consultant-demand", consultantId] as const;

/** The expert's own booking load: the demand banner and the live counts in Settings → Booking. */
export function useExpertDemand(consultantId: string) {
  return useQuery({
    queryKey: expertDemandQueryKey(consultantId),
    queryFn: async () => {
      const res = await fetch(`/api/user/consultants/${consultantId}/demand`, {
        cache: "no-store",
      });
      const body = await parseJsonResponse(
        res,
        demandResponseSchema,
        "Couldn't read your booking load",
      );
      return body.data;
    },
    staleTime: 60_000,
    retry: false,
  });
}
