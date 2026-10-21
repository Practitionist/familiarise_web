"use client";

import { useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import { throwSupportError } from "@/lib/support/error-copy";
import { invalidateSupportCase, supportKeys } from "@/lib/support/support-keys";
import type { CaseWorkspace } from "@/types/support-case";

export const Outcome = z.enum([
  "NO_REMEDY",
  "SERVICE_REMEDY",
  "REFUND_APPROVED",
  "REFUND_DECLINED",
  "UPHELD",
  "OVERTURNED",
]);
export type DecisionOutcome = z.infer<typeof Outcome>;

/** The server opens a seven-day appeal window when it records a decision. */
export const DECISION_APPEAL_DAYS = 7;

export const OUTCOME_LABEL: Record<DecisionOutcome, string> = {
  NO_REMEDY: "No remedy",
  SERVICE_REMEDY: "Service remedy",
  REFUND_APPROVED: "Refund approved",
  REFUND_DECLINED: "Refund declined",
  UPHELD: "Original decision upheld",
  OVERTURNED: "Original decision overturned",
};

const Resolution = z.object({
  data: z.object({
    decisions: z.array(
      z.object({
        id: z.string(),
        outcome: Outcome,
        explanation: z.string(),
        privateRationale: z.string().nullish(),
        createdAt: z.string(),
        appealUntil: z.string().nullable(),
      }),
    ),
    recommendations: z.array(
      z.object({
        id: z.string(),
        paymentId: z.string(),
        amountPaise: z.coerce.number(),
        reason: z.string(),
        approved: z.boolean().nullable(),
        decidedAt: z.string().nullable(),
        refund: z.object({ id: z.string(), status: z.string() }).nullable(),
      }),
    ),
    holds: z.array(
      z.object({
        id: z.string(),
        paymentId: z.string(),
        reason: z.string(),
        releasedAt: z.string().nullable(),
      }),
    ),
    evidenceRequests: z.array(
      z.object({
        id: z.string(),
        recipientUserId: z.string(),
        prompt: z.string(),
        dueAt: z.string(),
        responseBody: z.string().nullable(),
        respondedAt: z.string().nullable(),
        cancelledAt: z.string().nullable(),
      }),
    ),
    recipients: z.array(
      z.object({ id: z.string(), name: z.string().nullable() }),
    ),
    canManage: z.boolean(),
    canExecuteMoney: z.boolean(),
    ownershipScope: z.enum(["PERSONAL", "ORG_OPERATIONS", "ORG_BILLING"]),
    updatedAt: z.string(),
  }),
});
export type CaseResolution = z.infer<typeof Resolution>["data"];

export const ProposedRefund = z.object({
  status: z.literal("PROPOSED"),
  proposalId: z.string(),
  expiresAt: z.string().datetime(),
});
export type RefundProposal = z.infer<typeof ProposedRefund>;

export function useCaseResolution(caseId: string) {
  return useQuery({
    queryKey: supportKeys.resolution(caseId),
    queryFn: async () => {
      const response = await fetch(`/api/support/cases/${caseId}/actions`);
      if (!response.ok)
        await throwSupportError(response, "case resolution load");
      return Resolution.parse(await response.json()).data;
    },
  });
}

/** The CAS token for case writes: the workspace query, refetched first if a mutation invalidated it. */
export async function freshCaseUpdatedAt(
  qc: QueryClient,
  caseId: string,
): Promise<string | undefined> {
  const key = supportKeys.workspace(caseId);
  if (qc.getQueryState(key)?.isInvalidated)
    await qc.refetchQueries({ queryKey: key, exact: true });
  return qc.getQueryData<CaseWorkspace>(key)?.updatedAt;
}

export type CaseActionPayload =
  | {
      action: "DECIDE";
      outcome: DecisionOutcome;
      explanation: string;
      privateRationale?: string;
    }
  | { action: "REQUEST_EVIDENCE"; recipientUserId: string; prompt: string }
  | { action: "CANCEL_EVIDENCE"; requestId: string; reason: string }
  | {
      action: "RECOMMEND_REFUND";
      paymentId: string;
      amountPaise: number;
      reason: string;
    }
  | {
      action: "REVIEW_REFUND";
      recommendationId: string;
      approve: boolean;
      reason: string;
      expectedRefundablePaise?: number;
    }
  | { action: "APPLY_HOLD"; paymentId: string; reason: string }
  | { action: "RELEASE_HOLD"; holdId: string; reason: string }
  | { action: "HANDOVER"; reason: string };

/** One staff case-action mutation; every success or failure refreshes the case subtree. */
export function useCaseAction(caseId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const actionIds = useRef(new Map<string, string>());
  return useMutation({
    mutationFn: async (
      payload: CaseActionPayload,
    ): Promise<(RefundProposal & { recommendationId: string }) | null> => {
      const expectedUpdatedAt = await freshCaseUpdatedAt(qc, caseId);
      if (!expectedUpdatedAt)
        throw new Error("Refresh the case before continuing.");
      const key = JSON.stringify(payload);
      const clientActionId = actionIds.current.get(key) ?? crypto.randomUUID();
      actionIds.current.set(key, clientActionId);
      const response = await fetchWithReauth(
        `/api/support/cases/${caseId}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            expectedUpdatedAt,
            clientActionId,
          }),
        },
      );
      if (!response.ok) await throwSupportError(response, "support action");
      actionIds.current.delete(key);
      if (response.status !== 202 || payload.action !== "REVIEW_REFUND")
        return null;
      return {
        ...ProposedRefund.parse(await response.json()),
        recommendationId: payload.recommendationId,
      };
    },
    onSuccess: (proposal) => {
      toast(
        proposal
          ? {
              title: "Sent to another admin for approval",
              description:
                "The refund has not been sent. Track it in Money → Approvals.",
            }
          : { title: "Case updated" },
      );
      void qc.invalidateQueries({ queryKey: ["money-approvals"] });
    },
    onError: (error: unknown) =>
      toast({
        title: "The action was not completed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
    onSettled: () => invalidateSupportCase(qc, caseId),
  });
}
