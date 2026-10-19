"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import {
  CaseBulkResponseSchema,
  type CaseBulkAction,
  type CaseBulkOutcome,
} from "@/schemas/support-inbox";

export interface CaseBulkInput {
  action: CaseBulkAction;
  reason: string;
  caseKeys: string[];
}

/**
 * One action over a selection of cases. The server answers with an outcome
 * PER ROW, because a batch where some rows are refused must not be reported
 * as a single success.
 */
export function useCaseBulkAction() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (input: CaseBulkInput): Promise<CaseBulkOutcome[]> => {
      const res = await fetch("/api/staff/support-inbox/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) await throwSupportError(res, "bulk case action");
      const parsed = CaseBulkResponseSchema.parse(await res.json());
      return parsed.outcomes;
    },
    onSuccess: (outcomes) => {
      const failed = outcomes.filter((o) => o.status === "FAILED").length;
      const done = outcomes.length - failed;
      toast({
        title: failed
          ? `${done} of ${outcomes.length} updated`
          : `${done} ${done === 1 ? "case" : "cases"} updated`,
        description: failed
          ? `${failed} refused — the list says which.`
          : "Each updated case has its own audit row.",
        variant: failed ? "warning" : "success",
      });
      void qc.invalidateQueries({ queryKey: ["support-inbox"] });
      void qc.invalidateQueries({ queryKey: ["backoffice-nav-counts"] });
    },
    onError: (error: unknown) => {
      toast({
        title: "That didn't go through",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });
}
