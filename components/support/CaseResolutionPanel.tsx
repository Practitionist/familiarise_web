"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { CaseAttachments } from "./CaseAttachments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { formatCurrencyAmount } from "@/utils/formatting";
import { humanizeEnum } from "@/lib/ui/tone";
import { fetchWithReauth } from "@/lib/auth/reauth-client";

const Outcome = z.enum([
  "NO_REMEDY",
  "SERVICE_REMEDY",
  "REFUND_APPROVED",
  "REFUND_DECLINED",
  "UPHELD",
  "OVERTURNED",
]);
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
const Preview = z.object({
  data: z.object({
    refundablePaise: z.number(),
    amountPaise: z.number(),
    rail: z.string(),
    blockedReason: z.string().nullable(),
  }),
});
type RefundPreview = z.infer<typeof Preview>["data"] & {
  recommendationId: string;
};
const ProposedRefund = z.object({
  status: z.literal("PROPOSED"),
  proposalId: z.string(),
  expiresAt: z.string().datetime(),
});
type RefundProposal = z.infer<typeof ProposedRefund>;
type PendingRefund = RefundProposal & { recommendationId: string };

async function post(url: string, body: object): Promise<RefundProposal | null> {
  const response = await fetchWithReauth(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwSupportError(response, "support action");
  return response.status === 202
    ? ProposedRefund.parse(await response.json())
    : null;
}

export function CaseResolutionPanel({
  caseId,
  paymentId,
  customer = false,
}: Readonly<{ caseId: string; paymentId?: string; customer?: boolean }>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const endpoint = `/api/support/cases/${caseId}/actions`;
  const queryKey = ["support-case-resolution", caseId];
  const [reason, setReason] = useState("");
  const [explanation, setExplanation] = useState("");
  const [privateRationale, setPrivateRationale] = useState("");
  const [outcome, setOutcome] = useState<z.infer<typeof Outcome>>("NO_REMEDY");
  const [recipient, setRecipient] = useState("");
  const [prompt, setPrompt] = useState("");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refundProposal, setRefundProposal] = useState<PendingRefund | null>(
    null,
  );
  const [appealing, setAppealing] = useState<string | null>(null);
  const actionIds = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await fetch(endpoint);
      if (!response.ok)
        await throwSupportError(response, "case resolution load");
      return Resolution.parse(await response.json()).data;
    },
  });
  const data = query.data;
  const action = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!data) throw new Error("Refresh the case before continuing.");
      const key = JSON.stringify(payload);
      const clientActionId = actionIds.current.get(key) ?? crypto.randomUUID();
      actionIds.current.set(key, clientActionId);
      const result = await post(endpoint, {
        ...payload,
        expectedUpdatedAt: data.updatedAt,
        clientActionId,
      });
      actionIds.current.delete(key);
      return result
        ? {
            ...result,
            recommendationId: z.string().parse(payload.recommendationId),
          }
        : null;
    },
    onSuccess: (proposal) => {
      setReason("");
      setPrompt("");
      setExplanation("");
      setPrivateRationale("");
      setPreview(null);
      setRefundProposal(proposal);
      toast(
        proposal
          ? {
              title: "Sent to another admin for approval",
              description:
                "The refund has not been sent. Track it in Money → Approvals.",
            }
          : { title: "Case updated" },
      );
      for (const key of [
        queryKey,
        ["support-case"],
        ["user-support-case"],
        ["support-inbox"],
        ["support-inbox-stats"],
        ["money-approvals"],
      ])
        void qc.invalidateQueries({ queryKey: key });
    },
    onError: (error: unknown) => {
      toast({
        title: "The action was not completed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
      setPreview(null);
      void query.refetch();
    },
  });
  const appeal = useMutation({
    mutationFn: async () => {
      if (!appealing) return;
      const key = `appeal:${appealing}:${reason.trim()}`;
      const clientIntakeId = actionIds.current.get(key) ?? crypto.randomUUID();
      actionIds.current.set(key, clientIntakeId);
      await post("/api/support/appeals", {
        decisionId: appealing,
        reason: reason.trim(),
        clientIntakeId,
      });
      actionIds.current.delete(key);
    },
    onSuccess: () => {
      setAppealing(null);
      setReason("");
      toast({
        title: "Appeal submitted",
        description: "Your appeal will be reviewed independently.",
      });
      void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
    },
    onError: (error: unknown) =>
      toast({
        title: "Your appeal was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });
  const loadPreview = async (recommendationId: string) => {
    setPreviewLoading(true);
    try {
      const response = await fetch(
        `/api/support/cases/${caseId}/recommendations/${recommendationId}/preview`,
      );
      if (!response.ok) await throwSupportError(response, "refund preview");
      setPreview({
        ...Preview.parse(await response.json()).data,
        recommendationId,
      });
    } catch (error) {
      toast({
        title: "Refund preview unavailable",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPreviewLoading(false);
    }
  };
  if (query.isLoading)
    return (
      <p className="text-xs text-muted-foreground">Loading case resolution…</p>
    );
  if (query.isError)
    return (
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        Retry case resolution
      </Button>
    );
  if (!data) return null;
  const busy = action.isPending || appeal.isPending;
  const canManage = data.canManage && !customer;
  const canMoney = data.canExecuteMoney && canManage;
  const amountPaise = Math.round(Number(amount) * 100);
  return (
    <section
      aria-label="Case resolution"
      className="space-y-4 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <h3 className="font-semibold">Resolution and review</h3>
      {canMoney &&
        refundProposal &&
        data.recommendations.some(
          (rec) => rec.id === refundProposal.recommendationId && !rec.decidedAt,
        ) && (
          <div
            role="status"
            className="space-y-1 rounded border border-border p-3"
          >
            <p className="font-medium">Waiting for another admin’s approval</p>
            <p className="text-xs text-muted-foreground">
              The refund has not been sent. This request expires{" "}
              {new Date(refundProposal.expiresAt).toLocaleString()}.
            </p>
            <a
              className="text-xs underline"
              href="/dashboard/admin/money/approvals"
            >
              View money approvals
            </a>
          </div>
        )}
      {customer && (
        <a
          className="text-sm underline"
          href={`/api/support/cases/${caseId}/receipt`}
        >
          Download submitted complaint
        </a>
      )}
      {data.decisions.map((decision) => (
        <div
          key={decision.id}
          className="space-y-2 border-b border-border pb-3"
        >
          <p className="font-medium">{humanizeEnum(decision.outcome)}</p>
          <p className="whitespace-pre-wrap">{decision.explanation}</p>
          {canManage && decision.privateRationale && (
            <p className="rounded border border-dashed border-border p-2 text-xs">
              Private rationale: {decision.privateRationale}
            </p>
          )}
          {customer &&
            decision.appealUntil &&
            new Date(decision.appealUntil).getTime() > Date.now() && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAppealing(decision.id);
                  setReason("");
                }}
              >
                Appeal this decision
              </Button>
            )}
        </div>
      ))}
      {appealing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            appeal.mutate();
          }}
          className="space-y-2"
        >
          <Textarea
            aria-label="Reason for appeal"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain what should be reconsidered."
            required
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !reason.trim()}>
              Submit appeal
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setAppealing(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {canManage && (
        <>
          <details>
            <summary className="cursor-pointer font-medium">Decision</summary>
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                action.mutate({
                  action: "DECIDE",
                  outcome,
                  explanation: explanation.trim(),
                  ...(privateRationale.trim()
                    ? { privateRationale: privateRationale.trim() }
                    : {}),
                });
              }}
            >
              <select
                aria-label="Decision outcome"
                className="w-full rounded-md border bg-background p-2"
                value={outcome}
                onChange={(event) =>
                  setOutcome(Outcome.parse(event.target.value))
                }
              >
                {Outcome.options
                  .filter(
                    (value) =>
                      data.canExecuteMoney ||
                      !["REFUND_APPROVED", "REFUND_DECLINED"].includes(value),
                  )
                  .map((value) => (
                    <option key={value} value={value}>
                      {humanizeEnum(value)}
                    </option>
                  ))}
              </select>
              <Textarea
                aria-label="Explanation for the customer"
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
                placeholder="Explanation the customer will receive"
                required
              />
              <Textarea
                aria-label="Private rationale"
                value={privateRationale}
                onChange={(event) => setPrivateRationale(event.target.value)}
                placeholder="Private operator rationale (optional)"
              />
              <Button size="sm" disabled={busy || !explanation.trim()}>
                Record decision and resolve
              </Button>
            </form>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">
              Private evidence
            </summary>
            <div className="mt-2 space-y-3">
              <p className="text-xs text-muted-foreground">
                Responses stay with the platform review team.
              </p>
              {data.evidenceRequests.map((request) => (
                <div
                  key={request.id}
                  className="space-y-1 rounded border border-border p-2 text-xs"
                >
                  <p>{request.prompt}</p>
                  <p className="text-muted-foreground">
                    Due {new Date(request.dueAt).toLocaleString()} ·{" "}
                    {request.cancelledAt
                      ? "Cancelled"
                      : request.respondedAt
                        ? "Responded"
                        : "Awaiting response"}
                  </p>
                  {request.responseBody && (
                    <p className="whitespace-pre-wrap">
                      {request.responseBody}
                    </p>
                  )}
                  {request.respondedAt &&
                    new Date(request.respondedAt) > new Date(request.dueAt) && (
                      <p className="text-muted-foreground">
                        Received after the requested deadline
                      </p>
                    )}
                  <CaseAttachments
                    caseId={caseId}
                    evidenceRequestId={request.id}
                  />
                  {!request.respondedAt && !request.cancelledAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        action.mutate({
                          action: "CANCEL_EVIDENCE",
                          requestId: request.id,
                          reason: reason.trim(),
                        })
                      }
                    >
                      Cancel request
                    </Button>
                  )}
                </div>
              ))}
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  action.mutate({
                    action: "REQUEST_EVIDENCE",
                    recipientUserId: recipient,
                    prompt: prompt.trim(),
                  });
                }}
              >
                <select
                  aria-label="Evidence recipient"
                  className="w-full rounded-md border bg-background p-2"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  required
                >
                  <option value="">Select recipient</option>
                  {data.recipients.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name ?? person.id}
                    </option>
                  ))}
                </select>
                <Textarea
                  aria-label="Evidence request"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ask for specific evidence"
                  required
                />
                <Button
                  size="sm"
                  disabled={busy || !recipient || !prompt.trim()}
                >
                  Request evidence
                </Button>
              </form>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">
              Financial review
            </summary>
            <div className="mt-2 space-y-3">
              {data.recommendations.map((rec) => (
                <div
                  key={rec.id}
                  className="space-y-1 rounded border border-border p-2 text-xs"
                >
                  <p>
                    {formatCurrencyAmount(rec.amountPaise, "INR")} ·{" "}
                    {rec.reason}
                  </p>
                  <p>
                    {rec.decidedAt
                      ? rec.approved
                        ? `Approved${rec.refund ? ` · ${humanizeEnum(rec.refund.status)}` : ""}`
                        : "Declined"
                      : "Awaiting administrator review"}
                  </p>
                  {canMoney &&
                    (!rec.decidedAt || (rec.approved && !rec.refund)) && (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy || previewLoading || reason.trim().length < 5
                          }
                          onClick={() => void loadPreview(rec.id)}
                        >
                          {rec.approved
                            ? "Retry approved refund"
                            : "Review refund"}
                        </Button>
                        {!rec.decidedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || reason.trim().length < 5}
                            onClick={() =>
                              action.mutate({
                                action: "REVIEW_REFUND",
                                recommendationId: rec.id,
                                approve: false,
                                reason: reason.trim(),
                              })
                            }
                          >
                            Decline
                          </Button>
                        )}
                      </div>
                    )}
                </div>
              ))}
              {paymentId && (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    action.mutate({
                      action: "RECOMMEND_REFUND",
                      paymentId,
                      amountPaise,
                      reason: reason.trim(),
                    });
                  }}
                >
                  <p className="text-xs text-muted-foreground">
                    For a booking paid entirely with credits, enter 0 to request
                    full credit restoration.
                  </p>
                  <Input
                    aria-label="Recommended refund in rupees"
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="Refund amount (₹)"
                  />
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !reason.trim() ||
                      !Number.isSafeInteger(amountPaise) ||
                      amountPaise < 0
                    }
                  >
                    Recommend refund
                  </Button>
                </form>
              )}
              {data.holds.map((hold) => (
                <div
                  key={hold.id}
                  className="space-y-1 rounded border border-border p-2 text-xs"
                >
                  <p>
                    {hold.reason} ·{" "}
                    {hold.releasedAt ? "Released" : "Payment held"}
                  </p>
                  {canMoney && !hold.releasedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        action.mutate({
                          action: "RELEASE_HOLD",
                          holdId: hold.id,
                          reason: reason.trim(),
                        })
                      }
                    >
                      Release hold
                    </Button>
                  )}
                </div>
              ))}
              {canMoney && paymentId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    action.mutate({
                      action: "APPLY_HOLD",
                      paymentId,
                      reason: reason.trim(),
                    })
                  }
                >
                  Hold payment
                </Button>
              )}
            </div>
          </details>
        </>
      )}
      {(canManage || data.ownershipScope !== "PERSONAL") && (
        <Textarea
          aria-label="Action reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason for a financial action, cancellation, or handover"
        />
      )}
      {canMoney && (
        <p className="text-xs text-muted-foreground">
          Reviewing a refund needs a reason of at least 5 characters. Refunds
          over ₹25,000 need another admin’s approval when at least two admins
          are active.
        </p>
      )}
      {data.ownershipScope !== "PERSONAL" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !reason.trim()}
          onClick={() =>
            action.mutate({ action: "HANDOVER", reason: reason.trim() })
          }
        >
          Record organization handover
        </Button>
      )}
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review refund</AlertDialogTitle>
            <AlertDialogDescription>
              {preview &&
                (preview.rail === "CREDITS"
                  ? "Restore the booking's credits in full. No cash refund is sent."
                  : `${formatCurrencyAmount(preview.amountPaise, "INR")} through ${preview.rail}. Current refundable balance: ${formatCurrencyAmount(preview.refundablePaise, "INR")}.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-xs text-muted-foreground">
            If another admin’s approval is required, this creates an approval
            request and the refund waits for their decision.
          </p>
          {preview?.blockedReason && (
            <p role="alert" className="text-sm text-destructive">
              {preview.blockedReason}
            </p>
          )}
          <p className="text-sm">Reason: {reason}</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              disabled={
                busy ||
                Boolean(preview?.blockedReason) ||
                reason.trim().length < 5
              }
              onClick={() => {
                if (preview)
                  action.mutate({
                    action: "REVIEW_REFUND",
                    recommendationId: preview.recommendationId,
                    approve: true,
                    reason: reason.trim(),
                    expectedRefundablePaise: preview.refundablePaise,
                  });
              }}
            >
              Confirm refund review
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
