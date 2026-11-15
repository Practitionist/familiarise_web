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

/** Exact rupees-to-paise for a typed amount: plain digits, at most two decimals, no rounding. */
export function rupeesToPaise(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const paise =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(paise) ? paise : null;
}

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
        /** Set on an admin correction; the decision it names is no longer in force. */
        supersedesDecisionId: z.string().nullable(),
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
        releaseSeat: z.boolean(),
        /** Plan sessions the remedy removes; null for a money-only remedy. */
        sessionsRemoved: z.number().nullable(),
        voidedAt: z.string().nullable(),
        voidedById: z.string().nullable(),
        refund: z.object({ id: z.string(), status: z.string() }).nullable(),
        /** Set while a second-admin approval proposal is open. */
        pendingApprovalExpiresAt: z.string().nullable(),
      }),
    ),
    holds: z.array(
      z.object({
        /** The HOLD_APPLIED event id; RELEASE_HOLD takes it as holdId. */
        id: z.string(),
        paymentId: z.string(),
        reason: z.string(),
        createdAt: z.string(),
        releasedAt: z.string().nullable(),
        earningsHeld: z.number(),
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
    canManageHolds: z.boolean(),
    canVoidRecommendations: z.boolean(),
    /** Per-payment cumulative ceiling across live support refunds; null is unbounded. */
    refundLimitPaise: z.number().nullable(),
    /** The case's 1:1 plan payment, for a refund priced in sessions. */
    planRefund: z
      .object({
        paymentId: z.string(),
        amountPaise: z.number(),
        refundablePaise: z.number(),
        sessionsTotal: z.number(),
        sessionsRefunded: z.number(),
        removable: z.number(),
      })
      .nullable(),
    ownershipScope: z.enum(["PERSONAL", "ORG_OPERATIONS", "ORG_BILLING"]),
    updatedAt: z.string(),
    caseKind: z.enum(["INCIDENT", "PROBLEM"]),
    isAppeal: z.boolean(),
    /** A conduct removal case is upheld or overturned, like an appeal. */
    reviewsRemoval: z.boolean().optional(),
    legalHoldAt: z.string().nullable(),
    isAdmin: z.boolean(),
  }),
});
export type CaseResolution = z.infer<typeof Resolution>["data"];
type Decision = CaseResolution["decisions"][number];

/** The decision in force: the one no later decision supersedes. */
export function decisionInForce(decisions: readonly Decision[]) {
  const superseded = new Set(decisions.map((d) => d.supersedesDecisionId));
  return decisions.findLast((d) => !superseded.has(d.id)) ?? null;
}

const APPEAL_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set([
  "UPHELD",
  "OVERTURNED",
]);

/** Appeals and conduct removals are upheld or overturned; every other case gets a remedy outcome. */
export function outcomesFor(data: CaseResolution): DecisionOutcome[] {
  const reviewed = data.isAppeal || data.reviewsRemoval === true;
  return Outcome.options.filter(
    (value) =>
      reviewed === APPEAL_OUTCOMES.has(value) &&
      (data.canExecuteMoney ||
        (value !== "REFUND_APPROVED" && value !== "REFUND_DECLINED")),
  );
}

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
      supersedesDecisionId?: string;
    }
  | { action: "REQUEST_EVIDENCE"; recipientUserId: string; prompt: string }
  | { action: "CANCEL_EVIDENCE"; requestId: string; reason: string }
  | {
      action: "RECOMMEND_REFUND";
      paymentId: string;
      amountPaise: number;
      reason: string;
      releaseSeat: boolean;
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
  | { action: "VOID_RECOMMENDATION"; recommendationId: string; reason: string };

export type RunCaseAction = (
  payload: CaseActionPayload,
  onDone?: () => void,
) => void;

/** Admin-only: places or lifts the legal hold that blocks the post-closure evidence purge. */
export function useLegalHold(caseId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (legalHold: boolean) => {
      const expectedUpdatedAt = await freshCaseUpdatedAt(qc, caseId);
      if (!expectedUpdatedAt)
        throw new Error("Refresh the case before continuing.");
      const response = await fetchWithReauth(`/api/support/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ legalHold, expectedUpdatedAt }),
      });
      if (!response.ok) await throwSupportError(response, "legal hold");
    },
    onSuccess: (_result, legalHold) =>
      toast({ title: legalHold ? "Legal hold placed" : "Legal hold lifted" }),
    onError: (error: unknown) =>
      toast({
        title: "The legal hold was not changed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
    onSettled: () => invalidateSupportCase(qc, caseId),
  });
}

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
