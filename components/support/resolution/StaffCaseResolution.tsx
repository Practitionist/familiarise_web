"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { OperatorTime } from "@/lib/time/operator-time";
import { CaseAttachments } from "../CaseAttachments";
import { FinancialPanel } from "./FinancialPanel";
import { ReasonAction } from "./ReasonAction";
import {
  DECISION_APPEAL_DAYS,
  decisionInForce,
  Outcome,
  outcomeLabel,
  outcomesFor,
  useCaseAction,
  useCaseResolution,
  useLegalHold,
  type RunCaseAction,
  type CaseResolution,
  type DecisionOutcome,
} from "./resolution-data";

type Run = RunCaseAction;
const when = (iso: string) => <OperatorTime value={iso} />;

/**
 * Records the case's decision. Once one exists only an admin may supersede it,
 * while its appeal window is open; the correction keeps that window.
 */
function DecisionDialog({
  data,
  busy,
  run,
}: Readonly<{ data: CaseResolution; busy: boolean; run: Run }>) {
  const outcomes = outcomesFor(data);
  const [outcome, setOutcome] = useState<DecisionOutcome>(
    outcomes[0] ?? "NO_REMEDY",
  );
  const [explanation, setExplanation] = useState("");
  const [privateRationale, setPrivateRationale] = useState("");
  const [confirming, setConfirming] = useState(false);
  const current = decisionInForce(data.decisions);
  const supersedable =
    current?.appealUntil !== null &&
    current?.appealUntil !== undefined &&
    new Date(current.appealUntil).getTime() > Date.now();
  if (current && !(data.isAdmin && supersedable))
    return (
      <p className="text-xs text-muted-foreground">
        This case has a decision. An admin can supersede it while its appeal
        window is open; after that the customer can only appeal.
      </p>
    );
  const appealUntil = current?.appealUntil
    ? new Date(current.appealUntil)
    : new Date(Date.now() + DECISION_APPEAL_DAYS * 86_400_000);
  return (
    <details>
      <summary className="cursor-pointer font-medium">
        {current ? "Supersede decision" : "Decision"}
      </summary>
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
          {outcomes.map((value) => (
            <option key={value} value={value}>
              {outcomeLabel(data, value)}
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
          {current ? "Review decision" : "Record decision"}
        </Button>
      </form>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {current ? "Supersede this decision?" : "Record this decision?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {current
                ? "The new decision replaces the one in force and notifies the customer. The case stays resolved."
                : "Decisions can't be edited once recorded. Recording one resolves the case and notifies the customer."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Outcome</dt>
              <dd className="font-medium">{outcomeLabel(data, outcome)}</dd>
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
                The customer can appeal until {current ? "" : "about "}
                <OperatorTime value={appealUntil} />.
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
                    ...(current ? { supersedesDecisionId: current.id } : {}),
                  },
                  () => {
                    setConfirming(false);
                    setExplanation("");
                    setPrivateRationale("");
                  },
                )
              }
            >
              {current ? "Supersede decision" : "Record decision and resolve"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}

function LegalHoldToggle({
  caseId,
  legalHoldAt,
}: Readonly<{ caseId: string; legalHoldAt: string | null }>) {
  const hold = useLegalHold(caseId);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <p className="text-muted-foreground">
        {legalHoldAt ? (
          <>
            Legal hold since {when(legalHoldAt)}: evidence is kept past the
            retention period.
          </>
        ) : (
          "No legal hold: evidence is deleted 180 days after the case closes."
        )}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={hold.isPending}
        onClick={() => hold.mutate(!legalHoldAt)}
      >
        {legalHoldAt ? "Lift legal hold" : "Place legal hold"}
      </Button>
    </div>
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

/** Staff-only resolution tools; each panel keeps its own reason so text never crosses actions. */
export function StaffCaseResolution({
  caseId,
  paymentId,
  basePath,
}: Readonly<{ caseId: string; paymentId?: string; basePath: string }>) {
  const query = useCaseResolution(caseId);
  const action = useCaseAction(caseId);
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
  const superseded = new Set(
    data.decisions.map((decision) => decision.supersedesDecisionId),
  );
  const run: Run = (payload, onDone) =>
    action.mutate(payload, {
      onSuccess: () => onDone?.(),
    });
  return (
    <section
      aria-label="Case resolution"
      className="space-y-4 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <h3 className="font-semibold">Resolution and review</h3>
      {data.isAdmin && (
        <LegalHoldToggle caseId={caseId} legalHoldAt={data.legalHoldAt} />
      )}
      {data.decisions.map((decision) => (
        <div
          key={decision.id}
          className="space-y-2 border-b border-border pb-3"
        >
          <p className="font-medium">
            {outcomeLabel(data, decision.outcome)}
            {superseded.has(decision.id) ? " · Superseded" : ""}
          </p>
          <p className="whitespace-pre-wrap">{decision.explanation}</p>
          {decision.privateRationale && (
            <p className="rounded border border-dashed border-border p-2 text-xs">
              Private rationale: {decision.privateRationale}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Decided {when(decision.createdAt)}
            {decision.appealUntil && (
              <> · Appealable until {when(decision.appealUntil)}</>
            )}
          </p>
        </div>
      ))}
      {data.caseKind === "PROBLEM" ? (
        <p className="text-xs text-muted-foreground">
          A problem record is resolved, not decided. Record decisions on its
          linked incidents.
        </p>
      ) : (
        <DecisionDialog data={data} busy={busy} run={run} />
      )}
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
      />
    </section>
  );
}
