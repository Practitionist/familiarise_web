"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { useSession } from "@/lib/auth-client";
import { parseJsonResponse } from "@/lib/fetch-helpers";
import { expertDemandSchema } from "@/schemas/expert-demand";

const demandResponseSchema = z.object({ data: expertDemandSchema });

export const expertDemandQueryKey = (consultantId: string) =>
  ["consultant-demand", consultantId] as const;

/** The expert's own booking load: the demand banner and the live counts in Settings → Booking. */
export function useExpertDemand(consultantId: string) {
  // Owner-only: the route refuses an operator viewing the expert.
  const ownsPage =
    useSession().data?.user?.consultantProfileId === consultantId;
  return useQuery({
    queryKey: expertDemandQueryKey(consultantId),
    enabled: ownsPage,
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
