"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, PanelRight, X } from "lucide-react";
import { z } from "zod";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { bookingHref } from "@/lib/backoffice/booking-href";
import { caseStatus, ticketPriority } from "@/lib/labels/backoffice-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { parseCaseKey } from "@/lib/support/case-key";
import { CASE_TOPIC_LABEL, type CaseTopic } from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import { savedRepliesFor } from "@/lib/support/saved-replies";
import { slaHint } from "@/lib/support/sla-hint";
import { supportKeys } from "@/lib/support/support-keys";
import { formatDateTimeLabel } from "@/lib/time/display";
import type {
  ArticleLink,
  CaseWorkspace as CaseData,
} from "@/types/support-case";
import { formatCurrencyAmount } from "@/utils/formatting";

import { CaseDetails } from "./CaseDetails";
import { SupportInChatPill } from "./CaseChatPanel";
import { CaseConversation, type ComposerMode } from "./CaseConversation";
import { useCaseMutations } from "./useCaseMutations";
import styles from "./support-layout.module.css";
import { cn } from "@/utils/tailwind";

const UNASSIGNED = "unassigned";
const SETTLED = new Set(["RESOLVED", "CLOSED"]);
const DETAILS_ID = "support-case-details";

// Details open/closed is one preference across cases (localStorage).
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

const Operators = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
});

/** Staff and admins, for the assignee picker (the PATCH re-validates). */
function useOperators(enabled: boolean) {
  return useQuery({
    queryKey: supportKeys.operators(),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const read = async (role: string) => {
        const res = await fetch(`/api/admin/users?role=${role}`);
        if (!res.ok) return [];
        return Operators.parse(await res.json()).users;
      };
      const [staff, admins] = await Promise.all([read("STAFF"), read("ADMIN")]);
      return [...staff, ...admins];
    },
  });
}

const when = (iso: string | null) =>
  iso ? formatDateTimeLabel(new Date(iso)) : null;

/** Nothing is merged server-side, so the customer is only told where the conversation continues. */
export const duplicateMessage = (reference: string) =>
  `We'll continue in your other support request ${reference}, so everything stays in one place. This request is now closed.`;

export function DuplicateDialog({
  duplicates,
  target,
  onTargetChange,
  busy,
  onConfirm,
}: Readonly<{
  duplicates: { id: string; reference: string; title: string }[];
  target: string | null;
  onTargetChange: (id: string | null) => void;
  busy: boolean;
  onConfirm: (reference: string) => void;
}>) {
  const chosen = duplicates.find((d) => d.id === target);
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onTargetChange(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark as a duplicate?</AlertDialogTitle>
          <AlertDialogDescription>
            The customer gets the message below and this case closes. The other
            request keeps its own history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">
            Continue in
          </legend>
          {duplicates.map((d) => (
            <label key={d.id} className="flex items-start gap-2">
              <input
                type="radio"
                name="duplicate-target"
                value={d.id}
                checked={d.id === target}
                onChange={() => onTargetChange(d.id)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{d.reference}</span> · {d.title}
              </span>
            </label>
          ))}
        </fieldset>
        {chosen && (
          <p className="rounded border border-border p-2 text-sm">
            {duplicateMessage(chosen.reference)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={busy || !chosen}
            onClick={() => {
              if (chosen) onConfirm(chosen.reference);
            }}
          >
            Send and close
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One case: a two-row header, the conversation, and Details on demand (not a
 * modal: no backdrop, no focus trap). Header links only deep-link guarded flows.
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
  const detailsPanel = useRef<HTMLElement | null>(null);
  // Esc closes Details only from inside it: the conversation keeps its keys.
  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!detailsPanel.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      setDetailsOpen(false);
      detailsToggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailsOpen, setDetailsOpen]);
  const caseId = parseCaseKey(caseKey)?.id ?? caseKey;
  const query = useQuery({
    queryKey: supportKeys.workspace(caseId),
    queryFn: async (): Promise<CaseData> => {
      const res = await fetch(`/api/staff/support-inbox/${caseKey}`);
      if (!res.ok) await throwSupportError(res, "support case load");
      return ((await res.json()) as { data: CaseData }).data;
    },
    // The customer replies from their side; nothing pushes that here.
    refetchIntervalInBackground: false,
    refetchInterval: (q) =>
      q.state.data && SETTLED.has(q.state.data.status) ? false : 30_000,
  });
  const data = query.data;
  const { reply, setStatus, update } = useCaseMutations(data);
  const operators = useOperators(!!data?.caseId);
  useSetBreadcrumbLabel(data?.subject);

  const [mode, setMode] = useState<ComposerMode>("reply");
  const [replyDraft, setReplyDraft] = useState("");
  const [reassignNote, setReassignNote] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [duplicateTarget, setDuplicateTarget] = useState<string | null>(null);
  useEffect(() => {
    setMode("reply");
    setReplyDraft("");
    setReassignNote("");
    setConfirmClose(false);
    setDuplicateTarget(null);
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

  const sla = slaHint(data.sla);
  const settled = SETTLED.has(data.status);
  const insert = (text: string) => {
    setMode("reply");
    setReplyDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${text}` : text));
  };
  const selectReplyMacro = async (macro: {
    body: string;
    thenStatus?: "RESOLVED";
  }) => {
    if (!macro.thenStatus) {
      insert(macro.body);
      return;
    }
    try {
      await reply.mutateAsync({ message: macro.body, note: false });
    } catch {
      insert(macro.body);
      return;
    }
    // The status write refetches the invalidated case first and toasts its own failure.
    setStatus.mutate("RESOLVED");
  };
  const markDuplicate = async (reference: string) => {
    try {
      await reply.mutateAsync({
        message: duplicateMessage(reference),
        note: false,
      });
    } catch {
      return;
    }
    // A failed close toasts from the mutation, so staff can retry it.
    setStatus.mutate("CLOSED");
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
  const duplicates = data.duplicateOpenCases ?? [];

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
  const refundHref =
    data.payment && can("refunds.manage") && data.payment.status === "SUCCEEDED"
      ? `${basePath}/payments/${data.payment.id}?refund=1`
      : null;

  return (
    <div className={cn(styles.workspace, "space-y-3")}>
      <header className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="min-w-0 break-words text-base font-semibold text-foreground">
              {data.subject}
            </h2>
            <span className="min-w-0 break-words text-xs text-muted-foreground">
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
                onClick={() => setConfirmClose(true)}
              >
                Close
              </Button>
            )}
            {settled && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={busy}
                onClick={() =>
                  setStatus.mutate(
                    data.status === "CLOSED" ? "OPEN" : "IN_PROGRESS",
                  )
                }
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 break-words text-xs text-muted-foreground [&>span]:min-w-0">
          <span>
            <span className="font-medium text-foreground">
              {data.person.name ?? "Unknown user"}
            </span>
            {data.person.email ? ` (${data.person.email})` : ""}
          </span>
          {data.booking && (
            <span>
              <span className="font-medium text-foreground">
                {data.booking.title}
              </span>
              {data.booking.firstStartsAt
                ? ` · ${when(data.booking.firstStartsAt)}`
                : ""}
            </span>
          )}
          {data.payment && (
            <span className="inline-flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {formatCurrencyAmount(
                  data.payment.amount,
                  data.payment.currency,
                )}
              </span>
              <StatusBadge
                {...paymentStatusBadge(data.payment.status)}
                size="sm"
              />
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge {...caseStatus(data.status)} />
          {sla && <StatusBadge {...sla} variant="dot" />}
          {data.person.callbackRequested && (
            <StatusBadge label="Callback" tone="critical" />
          )}
          {can("supportChat.read") && (
            <SupportInChatPill caseId={data.caseId} />
          )}
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
          {data.reviewDueAt && (
            <span className="text-xs font-medium text-foreground">
              Removal decision due {when(data.reviewDueAt)}
            </span>
          )}
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
            onValueChange={(id) => {
              const note = reassignNote.trim() || undefined;
              update.mutate({
                assignedToId: id === UNASSIGNED ? null : id,
                note,
              });
              setReassignNote("");
            }}
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
          <input
            type="text"
            value={reassignNote}
            onChange={(e) => setReassignNote(e.target.value)}
            placeholder="Reassignment note (optional)"
            aria-label="Reassignment note"
            className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground"
          />
          {data.assignee?.id !== viewerId && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={busy}
              onClick={() => {
                const note = reassignNote.trim() || undefined;
                update.mutate({ assignedToId: viewerId, note });
                setReassignNote("");
              }}
            >
              Assign to me
            </Button>
          )}
        </div>
        {duplicates.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs">
            <span className="text-foreground">
              Also open:{" "}
              {duplicates.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  <Link
                    href={`${basePath}/support/c_${d.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {d.reference}
                  </Link>
                </span>
              ))}
            </span>
            {data.status !== "CLOSED" && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={busy || reply.isPending}
                onClick={() => setDuplicateTarget(duplicates[0].id)}
              >
                Mark duplicate
              </Button>
            )}
          </div>
        )}
      </header>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this case?</AlertDialogTitle>
            <AlertDialogDescription>
              The customer won&apos;t be able to reply on a closed case, and you
              can only add private notes until it is reopened.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep open</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmClose(false);
                setStatus.mutate("CLOSED");
              }}
            >
              Close case
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DuplicateDialog
        duplicates={duplicates}
        target={duplicateTarget}
        onTargetChange={setDuplicateTarget}
        busy={busy || reply.isPending}
        onConfirm={(reference) => {
          setDuplicateTarget(null);
          void markDuplicate(reference);
        }}
      />

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
            onSelectReply={(macro) => void selectReplyMacro(macro)}
          />
        </div>
        <aside
          id={DETAILS_ID}
          aria-label="Case details"
          hidden={!detailsOpen}
          ref={detailsPanel}
          className={cn(
            styles.detailsPanel,
            "rounded-lg border border-border bg-card p-4 shadow-xl",
          )}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Case details</h3>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label="Close case details"
              onClick={() => {
                setDetailsOpen(false);
                detailsToggle.current?.focus();
              }}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <CaseDetails data={data} />
        </aside>
      </div>
    </div>
  );
}
