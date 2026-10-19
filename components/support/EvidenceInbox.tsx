"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { CaseAttachments } from "@/components/support/CaseAttachments";

/**
 * The evidence a case asked THIS person for. The list endpoint returns only
 * the caller's own requests; the per-request endpoint answers the prompt and
 * accepts the response.
 */
const EvidenceList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      caseId: z.string(),
      prompt: z.string(),
      dueAt: z.string(),
      respondedAt: z.string().nullable(),
      cancelledAt: z.string().nullable(),
    }),
  ),
});

const ResponseResult = z.object({
  data: z.object({ respondedAt: z.string(), late: z.boolean() }),
});

/** One open request, with the composer that answers it. */
function EvidenceRequest({
  request,
}: Readonly<{
  request: z.infer<typeof EvidenceList>["data"][number];
}>) {
  const [body, setBody] = useState("");
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const respond = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/support/evidence/${request.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          // One key per composed answer, so a double submit is one response.
          clientTurnId: crypto.randomUUID(),
        }),
      });
      if (!res.ok) await throwSupportError(res, "evidence response");
      return ResponseResult.parse(await res.json()).data;
    },
    onSuccess: (result) => {
      toast({
        title: result.late ? "Response sent (late)" : "Response sent",
        description: "Our team can now review the case.",
      });
      setBody("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["support-evidence"] });
    },
    onError: (error: unknown) => {
      toast({
        title: "The response was not sent",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
  });

  const closed = Boolean(request.respondedAt || request.cancelledAt);
  const overdue = !closed && new Date(request.dueAt).getTime() < Date.now();

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium">{request.prompt}</p>
        <StatusBadge
          label={
            request.cancelledAt
              ? "Cancelled"
              : request.respondedAt
                ? "Answered"
                : overdue
                  ? "Overdue"
                  : "Awaiting your response"
          }
          tone={
            request.cancelledAt
              ? "neutral"
              : request.respondedAt
                ? "success"
                : overdue
                  ? "critical"
                  : "warning"
          }
          size="sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Due {new Date(request.dueAt).toLocaleString()}
      </p>

      {request.respondedAt && (
        <p className="text-sm text-muted-foreground">
          Answered {new Date(request.respondedAt).toLocaleString()}
        </p>
      )}

      {!closed && (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? "Hide" : "Answer this request"}
          </Button>
          {open && (
            <div className="space-y-3">
              <label className="block text-sm font-medium" htmlFor={`evidence-${request.id}`}>
                Your response
              </label>
              <textarea
                id={`evidence-${request.id}`}
                className="min-h-28 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={body}
                maxLength={10_000}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Explain what happened, and what you can share about it."
              />
              <p className="text-xs text-muted-foreground">
                You can attach screenshots or documents below the response.
              </p>
              <CaseAttachments
                caseId={request.caseId}
                evidenceRequestId={request.id}
                canUpload
              />
              <Button
                size="sm"
                disabled={body.trim().length === 0 || respond.isPending}
                onClick={() => respond.mutate()}
              >
                {respond.isPending ? "Sending…" : "Send response"}
              </Button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

/**
 * The caller's own evidence requests. The endpoint returns only requests
 * addressed to the signed-in user, so this is a personal inbox, not a
 * moderation queue.
 */
export function EvidenceInbox() {
  const query = useQuery({
    queryKey: ["support-evidence"],
    queryFn: async () => {
      const res = await fetch("/api/support/evidence");
      if (!res.ok) await throwSupportError(res, "evidence inbox load");
      return EvidenceList.parse(await res.json()).data;
    },
  });

  const requests = query.data ?? [];
  const open = requests.filter((request) => !request.respondedAt && !request.cancelledAt);
  const closed = requests.filter((request) => request.respondedAt || request.cancelledAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evidence we have asked you for</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.isError ? (
          <div role="alert" className="text-sm">
            Could not load your evidence requests.{" "}
            <Button variant="link" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to answer. If a case needs something from you, it appears here.
          </p>
        ) : (
          <>
            {open.length > 0 && (
              <ul className="divide-y">
                {open.map((request) => (
                  <EvidenceRequest key={request.id} request={request} />
                ))}
              </ul>
            )}
            {closed.length > 0 && (
              <details className="pt-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  {closed.length} answered request{closed.length === 1 ? "" : "s"}
                </summary>
                <ul className="divide-y">
                  {closed.map((request) => (
                    <EvidenceRequest key={request.id} request={request} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
