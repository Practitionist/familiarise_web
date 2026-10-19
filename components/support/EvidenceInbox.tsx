"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CaseAttachments } from "./CaseAttachments";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

const Evidence = z.object({
  id: z.string(),
  prompt: z.string(),
  dueAt: z.string(),
  respondedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});
const List = z.object({ data: z.array(Evidence) });
const Detail = z.object({
  data: Evidence.extend({
    caseId: z.string(),
    responseBody: z.string().nullable(),
    caseClosed: z.boolean(),
    decisions: z.array(
      z.object({
        id: z.string(),
        outcome: z.string(),
        appealUntil: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export function EvidenceInbox() {
  const query = useQuery({
    queryKey: ["support-evidence"],
    queryFn: async () => {
      const response = await fetch("/api/support/evidence");
      if (!response.ok)
        await throwSupportError(response, "evidence requests load");
      return List.parse(await response.json()).data;
    },
  });
  if (!query.data?.length && !query.isError) return null;
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">Evidence requests</h2>
      {query.isError && (
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry loading requests
        </Button>
      )}
      {query.data?.map((request) => (
        <Link
          key={request.id}
          href={`/dashboard/evidence/${request.id}`}
          className="block rounded-lg border border-border p-3 focus-visible:outline focus-visible:outline-2"
        >
          <p className="line-clamp-2">{request.prompt}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {request.cancelledAt
              ? "Cancelled"
              : request.respondedAt
                ? "Response submitted"
                : `Respond by ${new Date(request.dueAt).toLocaleString()}`}
          </p>
        </Link>
      ))}
    </section>
  );
}

export function EvidenceRequest({
  requestId,
}: Readonly<{ requestId: string }>) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [appealDecision, setAppealDecision] = useState<string | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const appealId = useRef<string | null>(null);
  const turnId = useRef<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["support-evidence", requestId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await fetch(`/api/support/evidence/${requestId}`);
      if (!response.ok)
        await throwSupportError(response, "evidence request load");
      return Detail.parse(await response.json()).data;
    },
  });
  const submit = async () => {
    if (pending || !body.trim()) return;
    setPending(true);
    turnId.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/support/evidence/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          clientTurnId: turnId.current,
        }),
      });
      if (!response.ok) await throwSupportError(response, "evidence response");
      turnId.current = null;
      setBody("");
      await qc.invalidateQueries({ queryKey: ["support-evidence"] });
      toast({ title: "Evidence response submitted" });
    } catch (error) {
      toast({
        title: "Response was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };
  const appeal = async () => {
    if (!appealDecision || !appealReason.trim() || pending) return;
    setPending(true);
    appealId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/support/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionId: appealDecision,
          reason: appealReason.trim(),
          clientIntakeId: appealId.current,
        }),
      });
      if (!response.ok) await throwSupportError(response, "appeal submission");
      setAppealDecision(null);
      setAppealReason("");
      appealId.current = null;
      toast({ title: "Appeal submitted for independent review" });
    } catch (error) {
      toast({
        title: "Appeal was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };
  const data = query.data;
  if (query.isLoading) return <p role="status">Loading evidence request…</p>;
  if (!data)
    return (
      <Button onClick={() => void query.refetch()}>
        Retry loading request
      </Button>
    );
  const open = !data.respondedAt && !data.cancelledAt && !data.caseClosed;
  return (
    <section className="space-y-4 rounded-xl border border-border p-5">
      <h1 className="text-xl font-semibold">Evidence request</h1>
      <p className="whitespace-pre-wrap">{data.prompt}</p>
      <p className="text-sm text-muted-foreground">
        Respond by {new Date(data.dueAt).toLocaleString()}. Your response is
        shared with the platform investigation team.
      </p>
      {data.cancelledAt && <p role="status">This request was cancelled.</p>}
      {data.caseClosed && <p role="status">The investigation has concluded.</p>}
      {data.decisions.map((decision) => (
        <div
          key={decision.id}
          className="space-y-2 rounded-lg border border-border p-3"
        >
          <p>
            Platform decision recorded on{" "}
            {new Date(decision.createdAt).toLocaleDateString()}.
          </p>
          {new Date(decision.appealUntil) > new Date() && (
            <Button
              variant="outline"
              onClick={() => {
                setAppealDecision(decision.id);
                setAppealReason("");
                appealId.current = null;
              }}
            >
              Appeal this decision
            </Button>
          )}
        </div>
      ))}
      {appealDecision && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void appeal();
          }}
        >
          <label htmlFor="evidence-appeal" className="text-sm font-medium">
            Reason for appeal
          </label>
          <Textarea
            id="evidence-appeal"
            value={appealReason}
            maxLength={10000}
            onChange={(event) => {
              setAppealReason(event.target.value);
              appealId.current = null;
            }}
            required
          />
          <Button disabled={pending || !appealReason.trim()}>
            Submit appeal
          </Button>
        </form>
      )}
      {data.responseBody && (
        <div className="whitespace-pre-wrap rounded-lg bg-muted p-4">
          <p className="mb-2 font-medium">Your submitted response</p>
          {data.responseBody}
        </div>
      )}
      <CaseAttachments
        caseId={data.caseId}
        evidenceRequestId={data.id}
        canUpload={open}
      />
      {open && (
        <>
          <label
            className="block text-sm font-medium"
            htmlFor="evidence-response"
          >
            Your response
          </label>
          <Textarea
            id="evidence-response"
            value={body}
            maxLength={10000}
            onChange={(event) => {
              setBody(event.target.value);
              turnId.current = null;
            }}
            disabled={pending}
          />
          <Button
            disabled={pending || !body.trim()}
            onClick={() => void submit()}
          >
            {pending ? "Submitting…" : "Submit response"}
          </Button>
        </>
      )}
    </section>
  );
}
