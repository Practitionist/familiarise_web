"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, PanelRight } from "lucide-react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { savedRepliesFor } from "@/lib/support/saved-replies";
import { slaHint } from "@/lib/support/sla-hint";
import type {
  ArticleLink,
  CaseWorkspace as CaseData,
} from "@/types/support-case";

import { bookingHref, CaseDetails } from "./CaseDetails";
import { CaseConversation, type ComposerMode } from "./CaseConversation";
import { useCaseMutations } from "./useCaseMutations";

const UNASSIGNED = "unassigned";
const SETTLED = new Set(["RESOLVED", "CLOSED"]);
const DETAILS_ID = "support-case-details";

// #1527 — Details open/closed is one preference across cases (localStorage).
const DETAILS_KEY = "support-details-open";
const DETAILS_EVENT = "support-details-change";

function subscribeDetails(onChange: () => void) {
  window.addEventListener(DETAILS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DETAILS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readDetails(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDetails(open: boolean) {
  try {
    window.localStorage.setItem(DETAILS_KEY, open ? "1" : "0");
  } catch {
    // Private mode or a full quota: the choice lasts until the next case.
  }
  window.dispatchEvent(new Event(DETAILS_EVENT));
}

function useDetailsOpen() {
  const open = useSyncExternalStore(subscribeDetails, readDetails, () => false);
  return [open, writeDetails] as const;
}

// Pushes the conversation narrower at >=1440px; below, it overlays the right
// edge without a backdrop so the conversation stays usable (#1527).
const DETAILS_PANEL =
  "absolute inset-y-0 right-0 z-20 w-80 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl " +
  "[@media(min-width:1440px)]:static [@media(min-width:1440px)]:w-72 [@media(min-width:1440px)]:max-w-none [@media(min-width:1440px)]:shrink-0 [@media(min-width:1440px)]:self-start [@media(min-width:1440px)]:shadow-none";

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
 * #1527 — one case: a two-row header, the conversation, and Details on
 * demand (not a modal: no backdrop, no focus trap). Every action goes through
 * the existing ticket and thread routes (useCaseMutations); the header's links
 * only deep-link existing guarded flows, and nothing here moves money.
 */
export function CaseWorkspace({
  caseKey,
  articles,
  helpArticles,
}: Readonly<{
  caseKey: string;
  articles: Record<CaseTopic, ArticleLink[]>;
  helpArticles: ArticleLink[];
}>) {
  const { viewerId, basePath, can } = useBackofficeCapability();
  const [detailsOpen, setDetailsOpen] = useDetailsOpen();
  const detailsToggle = useRef<HTMLButtonElement | null>(null);
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

  const links: { label: string; href: string }[] = [];
  if (data.booking && can("appointments.manage")) {
    links.push({
      label: "Open booking",
      href: bookingHref(basePath, data.booking.appointmentId),
    });
  }
  if (data.payment) {
    links.push({
      label: "Open payment",
      href: `${basePath}/payments/${data.payment.id}`,
    });
  }
  if (can("users.read")) {
    links.push({
      label: "Open User 360",
      href: `${basePath}/users/${data.person.id}`,
    });
  }
  // Opens the payment page's own refund dialog; refunds.manage is admin only.
  const refundHref =
    data.payment && can("refunds.manage") && data.payment.status === "SUCCEEDED"
      ? `${basePath}/payments/${data.payment.id}?refund=1`
      : null;

  return (
    <div className="min-w-0 space-y-3">
      <header className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">
              {data.subject}
            </h2>
            <span className="shrink-0 text-xs text-muted-foreground">
              {[
                data.reference,
                CASE_TOPIC_LABEL[data.topic],
                when(data.createdAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {links.map((l) => (
              <Button
                key={l.label}
                size="sm"
                variant="ghost"
                className="h-8"
                asChild
              >
                <Link href={l.href}>{l.label}</Link>
              </Button>
            ))}
            {refundHref && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={refundHref}>Issue refund</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!settled && (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
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
                className="h-8"
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
                className="h-8"
                disabled={busy}
                onClick={() => setStatus.mutate("IN_PROGRESS")}
              >
                Reopen
              </Button>
            )}
            <Button
              ref={detailsToggle}
              size="sm"
              variant={detailsOpen ? "secondary" : "outline"}
              className="h-8"
              aria-expanded={detailsOpen}
              aria-controls={DETAILS_ID}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              <PanelRight className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Details
            </Button>
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
          {isTicket && (
            <>
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
                  className="h-8"
                  disabled={busy}
                  onClick={() => update.mutate({ assignedToId: viewerId })}
                >
                  Assign to me
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      <div className="relative flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <CaseConversation
            data={data}
            mode={mode}
            onModeChange={setMode}
            replyDraft={replyDraft}
            onReplyDraftChange={setReplyDraft}
            sending={reply.isPending}
            onSend={(message, note) => reply.mutateAsync({ message, note })}
            replies={savedRepliesFor(data.topic)}
            suggested={articles[data.topic] ?? []}
            helpArticles={helpArticles}
            onInsert={insert}
          />
        </div>
        <aside
          id={DETAILS_ID}
          aria-label="Case details"
          hidden={!detailsOpen}
          className={DETAILS_PANEL}
          // Esc closes only from inside: the conversation keeps its keys.
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setDetailsOpen(false);
            detailsToggle.current?.focus();
          }}
        >
          <CaseDetails data={data} />
        </aside>
      </div>
    </div>
  );
}
