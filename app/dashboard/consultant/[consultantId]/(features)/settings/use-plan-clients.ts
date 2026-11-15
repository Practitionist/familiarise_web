"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { parseJsonResponse } from "@/lib/fetch-helpers";
import { planClientsReadSchema } from "@/schemas/plan-clients";

const planClientsResponseSchema = z.object({ data: planClientsReadSchema });

/** The expert's live 1:1 plan clients and limit, for "3 of 5 active plan clients". */
export function usePlanClients(consultantId: string) {
  return useQuery({
    queryKey: ["consultant-plan-clients", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/user/consultants/${consultantId}/plan-clients`,
        { cache: "no-store" },
      );
      const body = await parseJsonResponse(
        res,
        planClientsResponseSchema,
        "Couldn't count your plan clients",
      );
      return body.data;
    },
    staleTime: 60_000,
    retry: false,
  });
}
