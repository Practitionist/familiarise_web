"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";
import { caseStatus, ticketPriority } from "@/lib/labels/backoffice-labels";
import { CASE_TOPIC_LABEL, type CaseTopic } from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import { slaHint } from "@/lib/support/sla-hint";
import type {
  ArticleLink,
  CaseWorkspace as CaseData,
} from "@/types/support-case";

import { CaseConversation, type ComposerMode } from "./CaseConversation";
import { CaseAssistPane, CaseContextPane } from "./CaseSidePanes";
import { useCaseMutations } from "./useCaseMutations";

const UNASSIGNED = "unassigned";
const SETTLED = new Set(["RESOLVED", "CLOSED"]);

interface Operator {
  id: string;
  name: string | null;
}

/** Staff and admins, for the assignee picker (the PATCH re-validates). */
function useOperators(enabled: boolean) {
  return useQuery({
    queryKey: ["support-operators"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Operator[]> => {
      const read = async (role: string) => {
        const res = await fetch(`/api/admin/users?role=${role}`);
        if (!res.ok) return [];
        return ((await res.json()) as { users: Operator[] }).users;
      };
      const [staff, admins] = await Promise.all([read("STAFF"), read("ADMIN")]);
      return [...staff, ...admins];
    },
  });
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

/**
 * #1527 — one case, three panes: context (left), the conversation with its
 * header and composer (centre), and assist (right). Below xl the two side
 * panes stack under the conversation. Every action goes through the existing
 * ticket and thread routes (useCaseMutations).
 */
export function CaseWorkspace({
  caseKey,
  articles,
}: Readonly<{
  caseKey: string;
  articles: Record<CaseTopic, ArticleLink[]>;
}>) {
  const { viewerId } = useBackofficeCapability();
  const query = useQuery({
    queryKey: ["support-case", caseKey],
    queryFn: async (): Promise<CaseData> => {
      const res = await fetch(`/api/staff/support-inbox/${caseKey}`);
      if (!res.ok) await throwSupportError(res, "support case load");
      return ((await res.json()) as { data: CaseData }).data;
    },
    // The customer replies from their side; nothing pushes that here.
    refetchInterval: (q) =>
      q.state.data && SETTLED.has(q.state.data.status) ? false : 30_000,
  });
  const data = query.data;
  const { reply, setStatus, update } = useCaseMutations(data);
  const operators = useOperators(!!data?.ticketId);
  useSetBreadcrumbLabel(data?.subject);

  const [mode, setMode] = useState<ComposerMode>("reply");
  const [replyDraft, setReplyDraft] = useState("");
  useEffect(() => {
    setMode("reply");
    setReplyDraft("");
  }, [caseKey]);

  if (query.isError && !data) {
    return (
      <ErrorState
        title="This case could not be loaded"
        description={
          query.error instanceof Error ? query.error.message : undefined
        }
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const isTicket = !!data.ticketId;
  const sla = slaHint(data.sla);
  const settled = SETTLED.has(data.status);
  const insert = (text: string) => {
    setMode("reply");
    setReplyDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${text}` : text));
  };
  const busy = setStatus.isPending || update.isPending;
  const assignee = data.assignee?.id ?? UNASSIGNED;
  const pickable = [
    ...(operators.data ?? []),
    ...(data.assignee &&
    !operators.data?.some((o) => o.id === data.assignee?.id)
      ? [data.assignee]
      : []),
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_16rem]">
      <div className="order-2 xl:order-1">
        <CaseContextPane data={data} />
      </div>

      <div className="order-1 min-w-0 space-y-3 xl:order-2">
        <header className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {data.subject}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[
                  data.reference,
                  CASE_TOPIC_LABEL[data.topic],
                  when(data.createdAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!settled && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStatus.mutate("RESOLVED")}
                >
                  Resolve
                </Button>
              )}
              {data.status !== "CLOSED" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStatus.mutate("CLOSED")}
                >
                  Close
                </Button>
              )}
              {settled && data.status !== "CLOSED" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setStatus.mutate("IN_PROGRESS")}
                >
                  Reopen
                </Button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge {...caseStatus(data.kind, data.status)} />
            {!isTicket && data.channel !== "HUMAN" && (
              <StatusBadge
                label="With the assistant"
                tone="neutral"
                variant="dot"
              />
            )}
            {sla && <StatusBadge {...sla} variant="dot" />}
            {data.ackDueAt &&
              !data.sla?.ackBreached &&
              data.sla?.msToAckDue !== null && (
                <span className="text-xs text-muted-foreground">
                  Reply due {when(data.ackDueAt)}
                </span>
              )}
            {data.resolutionDueAt && data.sla?.msToResolutionDue !== null && (
              <span className="text-xs text-muted-foreground">
                Resolve by {when(data.resolutionDueAt)}
              </span>
            )}
          </div>
          {isTicket && (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={data.priority ?? "MEDIUM"}
                disabled={busy}
                onValueChange={(priority) => update.mutate({ priority })}
              >
                <SelectTrigger
                  className="h-8 w-auto min-w-[8rem] text-xs"
                  aria-label="Priority"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["URGENT", "HIGH", "MEDIUM", "LOW"].map((p) => (
                    <SelectItem key={p} value={p}>
                      {ticketPriority(p).label} priority
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={assignee}
                disabled={busy}
                onValueChange={(id) =>
                  update.mutate({ assignedToId: id === UNASSIGNED ? null : id })
                }
              >
                <SelectTrigger
                  className="h-8 w-auto min-w-[10rem] text-xs"
                  aria-label="Assignee"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {pickable.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.id === viewerId ? "You" : (o.name ?? "Operator")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {data.assignee?.id !== viewerId && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => update.mutate({ assignedToId: viewerId })}
                >
                  Assign to me
                </Button>
              )}
            </div>
          )}
        </header>

        <CaseConversation
          data={data}
          mode={mode}
          onModeChange={setMode}
          replyDraft={replyDraft}
          onReplyDraftChange={setReplyDraft}
          sending={reply.isPending}
          onSend={(message, note) => reply.mutateAsync({ message, note })}
        />
      </div>

      <div className="order-3">
        <CaseAssistPane
          data={data}
          articles={articles[data.topic] ?? []}
          onInsert={insert}
        />
      </div>
    </div>
  );
}
