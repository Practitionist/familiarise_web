"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { offeringStatsQueryKey } from "@/lib/offerings/stats";

type ArchivePlanInput = { id: string; archived: boolean };

/** A 502 page or an empty 401 has no JSON; the fallback keeps a sentence. */
async function requireOk(response: Response, fallback: string) {
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error || fallback);
  }
  return response.json();
}

/**
 * The Offerings list's writes (#1494, #1527). The READ of webinar/class
 * instances lives in createConsultantQueries(...).planner under
 * ["consultant-planner", consultantId, scope]; every write here invalidates
 * that prefix, the two 1:1 plan lists and the per-offering stats, so the card,
 * its counts and its Delete eligibility move together. Refusals are thrown for
 * the caller (the confirm dialog shows them inline), never toasted twice.
 */
function useOfferingWrite<TInput>(
  consultantId: string,
  mutationFn: (input: TInput) => Promise<{ message?: string }>,
  success: (input: TInput, result: { message?: string }) => string,
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn,
    onSuccess: (result, input) => {
      for (const queryKey of [
        ["consultant-planner", consultantId],
        ["consultationPlans", consultantId],
        ["subscriptionPlans", consultantId],
        offeringStatsQueryKey(consultantId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      toast({ title: success(input, result) });
    },
  });
}

const PLAN_PATH = {
  consultation: "/api/plans/consultations",
  subscription: "/api/plans/subscriptions",
  webinar: "/api/plans/webinars",
  class: "/api/plans/classes",
} as const;

/** Archive or restore a plan of any family (#1494). */
export function useArchiveOffering(
  consultantId: string,
  type: keyof typeof PLAN_PATH,
) {
  return useOfferingWrite<ArchivePlanInput>(
    consultantId,
    async ({ id, archived }) =>
      requireOk(
        await fetch(`${PLAN_PATH[type]}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        }),
        "Couldn't update this offering",
      ),
    ({ archived }) => (archived ? "Offering archived" : "Offering restored"),
  );
}

/**
 * Delete a 1:1 or subscription PLAN, or a webinar/class SESSION instance —
 * the guarded booking routes check payments and upcoming slots (#622).
 */
const DELETE_PATH = {
  consultation: "/api/plans/consultations",
  subscription: "/api/plans/subscriptions",
  webinar: "/api/bookings/webinars",
  class: "/api/bookings/classes",
} as const;

export function useDeleteOffering(
  consultantId: string,
  type: keyof typeof DELETE_PATH,
) {
  return useOfferingWrite<string>(
    consultantId,
    async (id) =>
      requireOk(
        await fetch(`${DELETE_PATH[type]}/${id}`, { method: "DELETE" }),
        "Couldn't delete this offering",
      ),
    () => "Offering deleted",
  );
}

function usePlanList(
  key: "consultationPlans" | "subscriptionPlans",
  path: string,
  consultantId: string,
) {
  return useQuery({
    queryKey: [key, consultantId],
    queryFn: async () => {
      // The list route caps at 50; the owner arm returns drafts too (Q4).
      const response = await fetch(
        `${path}?consultantId=${encodeURIComponent(consultantId)}&limit=50`,
      );
      const body = await requireOk(response, "Failed to load your plans");
      return body.data;
    },
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}

export const useConsultationPlans = (consultantId: string) =>
  usePlanList("consultationPlans", PLAN_PATH.consultation, consultantId);

export const useSubscriptionPlans = (consultantId: string) =>
  usePlanList("subscriptionPlans", PLAN_PATH.subscription, consultantId);
