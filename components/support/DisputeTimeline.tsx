"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
} from "@/lib/support/disputes/protocol";

/**
 * The dispute timeline.
 *
 * One ordered stream, mixing what each party said with what the system did.
 * The reference product's shape — claim, then the seller's answer, then the
 * buyer's decision on that answer, then the platform's ruling — is what
 * people already recognise, so the timeline is built the same way and every
 * turn states plainly whose move it is.
 */

const DisputeDetail = z.object({
  data: z.object({
    id: z.string(),
    referenceNumber: z.string(),
    status: z.string(),
    statusLabel: z.string(),
    statusOwner: z.string(),
    reason: z.string(),
    reasonLabel: z.string(),
    remark: z.string(),
    round: z.number(),
    version: z.number(),
    viewerRole: z.enum(["PLATFORM", "BUYER", "RESPONDENT"]),
    amountPaise: z.number(),
    refundMethod: z.string().nullable(),
    respondentResponse: z.string().nullable(),
    respondentAcceptedRefund: z.boolean().nullable(),
    respondentRespondedAt: z.string().nullable(),
    respondentDueAt: z.string().nullable(),
    buyerDecision: z.string().nullable(),
    buyerDecisionAt: z.string().nullable(),
    escalatedAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string(),
    case: z.object({
      id: z.string(),
      referenceNumber: z.string(),
      status: z.string(),
      title: z.string(),
      messages: z.array(
        z.object({
          id: z.string(),
          seq: z.number(),
          sender: z.string(),
          body: z.string(),
          createdAt: z.string(),
          authorUserId: z.string().nullable(),
        }),
      ),
    }),
    timeline: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        fromStatus: z.string().nullable(),
        toStatus: z.string().nullable(),
        actorUserId: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
});

const ActionResult = z.object({
  data: z.object({
    replayed: z.boolean(),
    status: z.string(),
    version: z.number(),
  }),
});

function Turn({
  title,
  body,
  at,
  tone = "neutral",
}: Readonly<{
  title: string;
  body?: string | null;
  at: string;
  tone?: "neutral" | "info" | "success" | "warning";
}>) {
  return (
    <li className="space-y-1 border-l-2 border-border pl-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge label={title} tone={tone} size="sm" variant="pill" />
        <time dateTime={at} className="text-xs text-muted-foreground">
          {new Date(at).toLocaleString()}
        </time>
      </div>
      {body ? <p className="whitespace-pre-wrap text-sm">{body}</p> : null}
    </li>
  );
}

export function DisputeTimeline({
  referenceNumber,
  disputeHref,
}: Readonly<{ referenceNumber: string; disputeHref: string }>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [response, setResponse] = useState("");
  const [acceptRefund, setAcceptRefund] = useState(true);

  const query = useQuery({
    queryKey: ["purchase-dispute", referenceNumber],
    queryFn: async () => {
      const res = await fetch(
        `/api/purchases/disputes/${encodeURIComponent(referenceNumber)}`,
      );
      if (!res.ok) throw new Error("We could not load this dispute.");
      return DisputeDetail.parse(await res.json()).data;
    },
  });

  const act = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(
        `/api/purchases/disputes/${encodeURIComponent(referenceNumber)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error ?? "That action did not go through.");
      }
      return ActionResult.parse(await res.json()).data;
    },
    onSuccess: (result) => {
      toast({
        title: result.replayed ? "Already recorded" : "Recorded",
        description: result.replayed
          ? "We had that already — nothing was duplicated."
          : undefined,
      });
      setResponse("");
      void qc.invalidateQueries({ queryKey: ["purchase-dispute", referenceNumber] });
    },
    onError: (error: unknown) => {
      toast({
        title: "That did not go through",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading dispute…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <div role="alert" className="text-sm">
        We could not load this dispute.{" "}
        <Button variant="link" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const d = query.data;
  const isTerminal = ["RESOLVED", "WITHDRAWN", "CLOSED"].includes(d.status);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{d.reasonLabel}</h2>
          <StatusBadge
            label={d.statusLabel}
            tone={
              d.status === "RESOLVED"
                ? "success"
                : d.status === "ESCALATED" || d.status === "UNDER_REVIEW"
                  ? "info"
                  : "warning"
            }
            size="sm"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Reference <span className="tabular-nums">{d.referenceNumber}</span> ·
          Round {d.round} · {formatCurrencyAmount(d.amountPaise, "INR")} at
          stake · Next move: {d.statusOwner}
        </p>
      </header>

      <ol className="space-y-0">
        <Turn
          title="You raised this dispute"
          body={d.remark}
          at={d.createdAt}
          tone="info"
        />
        {d.respondentResponse ? (
          <Turn
            title={
              d.respondentAcceptedRefund
                ? "The expert accepted your claim"
                : "The expert declined your claim"
            }
            body={d.respondentResponse}
            at={d.respondentRespondedAt ?? d.createdAt}
            tone={d.respondentAcceptedRefund ? "success" : "warning"}
          />
        ) : d.respondentDueAt ? (
          <Turn
            title="Waiting for the expert to respond"
            body={`We asked them to reply by ${new Date(d.respondentDueAt).toLocaleDateString()}. If they do not, our team steps in.`}
            at={d.createdAt}
            tone="warning"
          />
        ) : null}
        {d.buyerDecision ? (
          <Turn
            title={
              d.buyerDecision === "ACCEPTED"
                ? "You accepted the expert's answer"
                : "You rejected the expert's answer"
            }
            body={
              d.buyerDecision === "REJECTED"
                ? "Your case went to our team for a decision."
                : "The case was closed without a refund."
            }
            at={d.buyerDecisionAt ?? d.createdAt}
            tone={d.buyerDecision === "ACCEPTED" ? "neutral" : "info"}
          />
        ) : null}
        {d.escalatedAt ? (
          <Turn
            title="Escalated to the Familiarise team"
            body="A specialist is reviewing the case and will decide what happens to the money."
            at={d.escalatedAt}
            tone="info"
          />
        ) : null}
        {d.resolvedAt ? (
          <Turn
            title="The case was closed"
            body="Our team has recorded the outcome on this payment."
            at={d.resolvedAt}
            tone="success"
          />
        ) : null}
      </ol>

      {d.case.messages.length > 0 && (
        <section aria-label="Messages" className="space-y-2">
          <h3 className="text-sm font-medium">Conversation</h3>
          <ul className="space-y-2">
            {d.case.messages.map((message) => (
              <li key={message.id} className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  {message.sender} ·{" "}
                  {new Date(message.createdAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap text-sm">{message.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isTerminal && d.viewerRole === "RESPONDENT" && d.status === "OPEN" && (
        <section aria-label="Your response" className="space-y-3">
          <h3 className="text-sm font-medium">Your response</h3>
          <label className="block text-sm" htmlFor="dispute-response">
            What happened?
          </label>
          <textarea
            id="dispute-response"
            className="min-h-28 w-full rounded-md border border-border bg-background p-2 text-sm"
            value={response}
            maxLength={10_000}
            onChange={(event) => setResponse(event.target.value)}
            placeholder="Explain what happened from your side. This is what the buyer sees."
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acceptRefund}
              onChange={(event) => setAcceptRefund(event.target.checked)}
            />
            I accept that this buyer should be refunded
          </label>
          <Button
            size="sm"
            disabled={
              response.trim().length === 0 ||
              act.isPending ||
              d.status !== "OPEN"
            }
            onClick={() =>
              act.mutate({
                action: "RESPOND",
                response,
                acceptRefund,
                expectedVersion: d.version,
                clientActionId: crypto.randomUUID(),
              })
            }
          >
            {act.isPending ? "Sending…" : "Send response"}
          </Button>
        </section>
      )}

      {!isTerminal && d.viewerRole === "BUYER" && d.status === "RESPONDED" && (
        <section aria-label="Your decision" className="space-y-3">
          <h3 className="text-sm font-medium">The expert answered</h3>
          <p className="text-sm text-muted-foreground">
            You can accept their answer, or send it to our team to decide.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending}
              onClick={() =>
                act.mutate({
                  action: "BUYER_ACCEPT",
                  expectedVersion: d.version,
                  clientActionId: crypto.randomUUID(),
                })
              }
            >
              Accept their answer
            </Button>
            <Button
              size="sm"
              disabled={act.isPending}
              onClick={() =>
                act.mutate({
                  action: "BUYER_REJECT",
                  expectedVersion: d.version,
                  clientActionId: crypto.randomUUID(),
                })
              }
            >
              Ask our team to decide
            </Button>
          </div>
        </section>
      )}

      {!isTerminal && d.viewerRole === "BUYER" && d.status === "OPEN" && (
        <p className="text-sm text-muted-foreground">
          We have asked the expert to respond. You do not need to do anything
          until they answer.
        </p>
      )}
    </div>
  );
}
