"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
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
import { formatDateTimeLabel } from "@/lib/time/display";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import { z } from "zod";
import { CaseAttachments } from "../CaseAttachments";
import {
  DECISION_APPEAL_DAYS,
  Outcome,
  OUTCOME_LABEL,
  rupeesToPaise,
  useCaseAction,
  useCaseResolution,
  type CaseActionPayload,
  type CaseResolution,
  type DecisionOutcome,
  type RefundProposal,
} from "./resolution-data";

type Run = (payload: CaseActionPayload, onDone?: () => void) => void;
const when = (iso: string) => formatDateTimeLabel(new Date(iso));

/** A one-off action that asks for its own reason inline before it runs. */
function ReasonAction({
  label,
  confirmLabel,
  busy,
  minLength = 1,
  onConfirm,
}: Readonly<{
  label: string;
  confirmLabel: string;
  busy: boolean;
  minLength?: number;
  onConfirm: (reason: string, done: () => void) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  if (!open)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(reason.trim(), () => {
          setOpen(false);
          setReason("");
        });
      }}
    >
      <Textarea
        ref={field}
        aria-label={`Reason: ${label}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (kept in the case's private history)"
        required
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || reason.trim().length < minLength}>
          {confirmLabel}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DecisionDialog({
  data,
  busy,
  run,
}: Readonly<{ data: CaseResolution; busy: boolean; run: Run }>) {
  const [outcome, setOutcome] = useState<DecisionOutcome>("NO_REMEDY");
  const [explanation, setExplanation] = useState("");
  const [privateRationale, setPrivateRationale] = useState("");
  const [confirming, setConfirming] = useState(false);
  const appealUntil = new Date(Date.now() + DECISION_APPEAL_DAYS * 86_400_000);
  return (
    <details>
      <summary className="cursor-pointer font-medium">Decision</summary>
      <form
        className="mt-2 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (explanation.trim()) setConfirming(true);
        }}
      >
        <select
          aria-label="Decision outcome"
          className="w-full rounded-md border bg-background p-2"
          value={outcome}
          onChange={(event) => setOutcome(Outcome.parse(event.target.value))}
        >
          {Outcome.options
            .filter(
              (value) =>
                data.canExecuteMoney ||
                !["REFUND_APPROVED", "REFUND_DECLINED"].includes(value),
            )
            .map((value) => (
              <option key={value} value={value}>
                {OUTCOME_LABEL[value]}
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
          Review decision
        </Button>
      </form>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record this decision?</AlertDialogTitle>
            <AlertDialogDescription>
              Decisions can&apos;t be edited once recorded. Recording one
              resolves the case and notifies the customer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Outcome</dt>
              <dd className="font-medium">{OUTCOME_LABEL[outcome]}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                The customer will read
              </dt>
              <dd className="whitespace-pre-wrap rounded border border-border p-2">
                {explanation.trim()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Appeal window</dt>
              <dd>
                The customer can appeal until about{" "}
                {formatDateTimeLabel(appealUntil)}.
              </dd>
            </div>
          </dl>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep editing</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() =>
                run(
                  {
                    action: "DECIDE",
                    outcome,
                    explanation: explanation.trim(),
                    ...(privateRationale.trim()
                      ? { privateRationale: privateRationale.trim() }
                      : {}),
                  },
                  () => {
                    setConfirming(false);
                    setExplanation("");
                    setPrivateRationale("");
                  },
                )
              }
            >
              Record decision and resolve
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}

function EvidenceRequestsPanel({
  caseId,
  data,
  busy,
  run,
}: Readonly<{
  caseId: string;
  data: CaseResolution;
  busy: boolean;
  run: Run;
}>) {
  const [recipient, setRecipient] = useState("");
  const [prompt, setPrompt] = useState("");
  return (
    <details>
      <summary className="cursor-pointer font-medium">Private evidence</summary>
      <div className="mt-2 space-y-3">
        <p className="text-xs text-muted-foreground">
          Responses stay with the platform review team.
        </p>
        {data.evidenceRequests.map((request) => {
          let status = "Awaiting response";
          if (request.cancelledAt) status = "Cancelled";
          else if (request.respondedAt) status = "Responded";
          const late =
            request.respondedAt !== null &&
            new Date(request.respondedAt) > new Date(request.dueAt);
          return (
            <div
              key={request.id}
              className="space-y-1 rounded border border-border p-2 text-xs"
            >
              <p>{request.prompt}</p>
              <p className="text-muted-foreground">
                Due {when(request.dueAt)} · {status}
              </p>
              {request.responseBody && (
                <p className="whitespace-pre-wrap">{request.responseBody}</p>
              )}
              {late && (
                <p className="text-muted-foreground">
                  Received after the requested deadline
                </p>
              )}
              <CaseAttachments caseId={caseId} evidenceRequestId={request.id} />
              {!request.respondedAt && !request.cancelledAt && (
                <ReasonAction
                  label="Cancel request"
                  confirmLabel="Cancel evidence request"
                  busy={busy}
                  onConfirm={(reason, done) =>
                    run(
                      {
                        action: "CANCEL_EVIDENCE",
                        requestId: request.id,
                        reason,
                      },
                      done,
                    )
                  }
                />
              )}
            </div>
          );
        })}
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              {
                action: "REQUEST_EVIDENCE",
                recipientUserId: recipient,
                prompt: prompt.trim(),
              },
              () => setPrompt(""),
            );
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
          <Button size="sm" disabled={busy || !recipient || !prompt.trim()}>
            Request evidence
          </Button>
        </form>
      </div>
    </details>
  );
}

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

function recommendationStatus(rec: CaseResolution["recommendations"][number]) {
  if (!rec.decidedAt) return "Awaiting administrator review";
  if (!rec.approved) return "Declined";
  return rec.refund
    ? `Approved · ${humanizeEnum(rec.refund.status)}`
    : "Approved";
}

function FinancialPanel({
  caseId,
  paymentId,
  basePath,
  data,
  busy,
  run,
  proposal,
}: Readonly<{
  caseId: string;
  paymentId?: string;
  basePath: string;
  data: CaseResolution;
  busy: boolean;
  run: Run;
  proposal: (RefundProposal & { recommendationId: string }) | null;
}>) {
  const { toast } = useToast();
  const reviewReasonId = useId();
  const [amount, setAmount] = useState("");
  const [recommendReason, setRecommendReason] = useState("");
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const canMoney = data.canExecuteMoney;
  const amountPaise = rupeesToPaise(amount);
  const amountValid = amountPaise !== null;
  const loadPreview = async (recommendationId: string) => {
    setPreviewLoading(true);
    try {
      const response = await fetch(
        `/api/support/cases/${caseId}/recommendations/${recommendationId}/preview`,
      );
      if (!response.ok) await throwSupportError(response, "refund preview");
      setReviewReason("");
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
  const pendingProposal =
    canMoney &&
    proposal &&
    data.recommendations.some(
      (rec) => rec.id === proposal.recommendationId && !rec.decidedAt,
    )
      ? proposal
      : null;
  return (
    <details>
      <summary className="cursor-pointer font-medium">Financial review</summary>
      <div className="mt-2 space-y-3">
        {pendingProposal && (
          <output className="block space-y-1 rounded border border-border p-3">
            <span className="block font-medium">
              Waiting for another admin’s approval
            </span>
            <span className="block text-xs text-muted-foreground">
              The refund has not been sent. This request expires{" "}
              {when(pendingProposal.expiresAt)}.
            </span>
            <Link
              className="text-xs underline"
              href={`${basePath}/money/approvals`}
            >
              View money approvals
            </Link>
          </output>
        )}
        {data.recommendations.map((rec) => (
          <div
            key={rec.id}
            className="space-y-1 rounded border border-border p-2 text-xs"
          >
            <p>
              {formatCurrencyAmount(rec.amountPaise, "INR")} · {rec.reason}
            </p>
            <p>{recommendationStatus(rec)}</p>
            {canMoney && (!rec.decidedAt || (rec.approved && !rec.refund)) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || previewLoading}
                  onClick={() => void loadPreview(rec.id)}
                >
                  {rec.approved ? "Retry approved refund" : "Review refund"}
                </Button>
                {!rec.decidedAt && (
                  <ReasonAction
                    label="Decline"
                    confirmLabel="Decline recommendation"
                    minLength={5}
                    busy={busy}
                    onConfirm={(reason, done) =>
                      run(
                        {
                          action: "REVIEW_REFUND",
                          recommendationId: rec.id,
                          approve: false,
                          reason,
                        },
                        done,
                      )
                    }
                  />
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
              if (amountPaise === null) return;
              run(
                {
                  action: "RECOMMEND_REFUND",
                  paymentId,
                  amountPaise,
                  reason: recommendReason.trim(),
                },
                () => {
                  setAmount("");
                  setRecommendReason("");
                },
              );
            }}
          >
            <p className="text-xs text-muted-foreground">
              For a booking paid entirely with credits, enter 0 to request full
              credit restoration.
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
            <Textarea
              aria-label="Reason for the refund recommendation"
              value={recommendReason}
              onChange={(event) => setRecommendReason(event.target.value)}
              placeholder="Why this refund is recommended"
            />
            <Button
              size="sm"
              disabled={busy || !recommendReason.trim() || !amountValid}
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
              {hold.reason} · {hold.releasedAt ? "Released" : "Payment held"}
            </p>
            {canMoney && !hold.releasedAt && (
              <ReasonAction
                label="Release hold"
                confirmLabel="Release this hold"
                busy={busy}
                onConfirm={(reason, done) =>
                  run({ action: "RELEASE_HOLD", holdId: hold.id, reason }, done)
                }
              />
            )}
          </div>
        ))}
        {canMoney && paymentId && (
          <ReasonAction
            label="Hold payment"
            confirmLabel="Hold this payment"
            busy={busy}
            onConfirm={(reason, done) =>
              run({ action: "APPLY_HOLD", paymentId, reason }, done)
            }
          />
        )}
        {canMoney && (
          <p className="text-xs text-muted-foreground">
            Reviewing a refund needs a reason of at least 5 characters. Refunds
            over ₹25,000 need another admin’s approval when at least two admins
            are active.
          </p>
        )}
      </div>
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
          <label htmlFor={reviewReasonId} className="text-sm font-medium">
            Refund review reason
          </label>
          <Textarea
            id={reviewReasonId}
            value={reviewReason}
            onChange={(event) => setReviewReason(event.target.value)}
            placeholder="At least 5 characters"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              disabled={
                busy ||
                Boolean(preview?.blockedReason) ||
                reviewReason.trim().length < 5
              }
              onClick={() => {
                if (preview)
                  run(
                    {
                      action: "REVIEW_REFUND",
                      recommendationId: preview.recommendationId,
                      approve: true,
                      reason: reviewReason.trim(),
                      expectedRefundablePaise: preview.refundablePaise,
                    },
                    () => setPreview(null),
                  );
              }}
            >
              Confirm refund review
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}

/** Staff-only resolution tools; each panel keeps its own reason so text never crosses actions. */
export function StaffCaseResolution({
  caseId,
  paymentId,
  basePath,
}: Readonly<{ caseId: string; paymentId?: string; basePath: string }>) {
  const query = useCaseResolution(caseId);
  const action = useCaseAction(caseId);
  const [proposal, setProposal] = useState<
    (RefundProposal & { recommendationId: string }) | null
  >(null);
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground">Loading case resolution…</p>
    );
  if (query.isError)
    return (
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        Retry case resolution
      </Button>
    );
  const data = query.data;
  if (!data.canManage) return null;
  const busy = action.isPending;
  const run: Run = (payload, onDone) =>
    action.mutate(payload, {
      onSuccess: (result) => {
        setProposal(result);
        onDone?.();
      },
    });
  return (
    <section
      aria-label="Case resolution"
      className="space-y-4 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <h3 className="font-semibold">Resolution and review</h3>
      {data.decisions.map((decision) => (
        <div
          key={decision.id}
          className="space-y-2 border-b border-border pb-3"
        >
          <p className="font-medium">{OUTCOME_LABEL[decision.outcome]}</p>
          <p className="whitespace-pre-wrap">{decision.explanation}</p>
          {decision.privateRationale && (
            <p className="rounded border border-dashed border-border p-2 text-xs">
              Private rationale: {decision.privateRationale}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Decided {when(decision.createdAt)}
            {decision.appealUntil
              ? ` · Appealable until ${when(decision.appealUntil)}`
              : ""}
          </p>
        </div>
      ))}
      <DecisionDialog data={data} busy={busy} run={run} />
      <EvidenceRequestsPanel
        caseId={caseId}
        data={data}
        busy={busy}
        run={run}
      />
      <FinancialPanel
        caseId={caseId}
        paymentId={paymentId}
        basePath={basePath}
        data={data}
        busy={busy}
        run={run}
        proposal={proposal}
      />
      {data.ownershipScope !== "PERSONAL" && (
        <ReasonAction
          label="Record organization handover"
          confirmLabel="Record handover"
          busy={busy}
          onConfirm={(reason, done) =>
            run({ action: "HANDOVER", reason }, done)
          }
        />
      )}
    </section>
  );
}
