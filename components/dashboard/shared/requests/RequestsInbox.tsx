"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AppointmentsType } from "@prisma/client";
import { Inbox, Loader2, RefreshCw } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";
import { EmptyState } from "@/components/dashboard/DataCard";
import type { AllocationAttemptKey } from "@/hooks/scheduling/useScheduling";
import {
  INBOX_TYPES,
  inboxQueryKey,
  inboxQueryString,
  nextInboxSearch,
  readInboxParams,
  toStampDate,
  type InboxParamsPatch,
  type InboxRowInput,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { requestsFreshnessBadge } from "@/lib/scheduling/requestsFreshness";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { cn } from "@/utils/tailwind";

import { BatchApproveBar } from "./BatchApproveBar";
import { InboxBuckets } from "./InboxBuckets";
import { InboxChips } from "./InboxChips";
import {
  InboxRow,
  answerableProposal,
  isDialogFreeApproval,
  type RowAction,
} from "./InboxRow";
import { InboxSortControl } from "./InboxSort";
import { TrialAcceptDialog, type TrialAcceptTarget } from "./TrialAcceptDialog";
import {
  RequestedSlotsDialog,
  type RequestedSlotsConfirmation,
} from "./components/RequestedSlotsDialog";
import {
  EMPTY_STATE,
  TOAST,
  TYPE_LABEL,
  errorSentence,
  nextReminderLine,
} from "./labels";
import {
  DecisionError,
  approveRequestedTimes,
  classifyRequestedConflict,
  declineRequest,
} from "./request-decision";

export interface RequestsInboxProps {
  consultantProfileId: string;
  /** "personal" (default) or an organisation id; forwarded as `?orgScope=`. */
  orgScope?: string;
  /** The RSC page's zone, so the seeded HTML and the hydrated tree agree. */
  viewerZone?: string | null;
}

interface FetchError extends Error {
  code?: string;
  status?: number;
}

async function fetchInbox(query: string): Promise<RequestsInboxPayload> {
  const response = await fetch(`/api/bookings/inbox?${query}`);
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    const error: FetchError = new Error(
      errorSentence(
        body.code,
        body.error ?? `Server error (${response.status})`,
      ),
    );
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body as unknown as RequestsInboxPayload;
}

/** A lifecycle POST (remind / withdraw) → its parsed body and status. */
async function postLifecycle(
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, { method: "POST" });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, body };
}

const requestType = (row: InboxRowInput): AppointmentsType =>
  row.kind === "subscription" || row.kind === "next-cycle"
    ? AppointmentsType.SUBSCRIPTION
    : AppointmentsType.CONSULTATION;

const requestPath = (row: InboxRowInput) =>
  `/api/bookings/${
    requestType(row) === AppointmentsType.SUBSCRIPTION
      ? "subscriptions"
      : "consultations"
  }/${encodeURIComponent(row.id)}`;

/**
 * Tabs, chips, sort and page live in the URL. Writes go through the native
 * history API, which the App Router syncs into `useSearchParams` (Next 14.1+):
 * the URL changes synchronously and no server round trip re-renders the page
 * for a filter click (QA #1783 case 3 — `router.replace` left the URL behind).
 */
function useInboxUrlState() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useMemo(
    () => readInboxParams((key) => searchParams.get(key)),
    [searchParams],
  );
  const setParams = useCallback(
    (patch: InboxParamsPatch) => {
      const qs = nextInboxSearch(searchParams.toString(), patch);
      window.history.replaceState(
        window.history.state,
        "",
        qs ? `${pathname}?${qs}` : pathname,
      );
    },
    [pathname, searchParams],
  );
  return { params, setParams };
}

/**
 * The consultant Requests inbox (#1775): type tabs, chips, sort and deadline
 * buckets over `readRequestsInbox`, every word from the presentation layer,
 * one primary action per row. State lives in the URL; the RSC page seeds the
 * query and this component keeps it fresh (30 s stale, refetch on focus).
 */
export function RequestsInbox({
  consultantProfileId,
  orgScope = "personal",
  viewerZone,
}: Readonly<RequestsInboxProps>) {
  const { params, setParams } = useInboxUrlState();
  // A breadcrumb / link may name one row; it is highlighted and scrolled to once.
  const focusId = useSearchParams().get("focus");
  const viewer = useViewerZone(viewerZone);
  const queryClient = useQueryClient();

  const chip = params.chip;
  const queryArgs = {
    consultantProfileId,
    scope: orgScope,
    type: params.type,
    chip,
    sort: params.sort,
    page: params.page,
  };
  const queryKey = inboxQueryKey(queryArgs);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchInbox(inboxQueryString(queryArgs)),
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["requests-inbox", consultantProfileId],
    });
    // Home's strips count the same cohort (#1775 A-6).
    void queryClient.invalidateQueries({
      queryKey: ["consultant-dashboard", consultantProfileId],
    });
  }, [consultantProfileId, queryClient]);

  // "N new · Refresh": a return to the tab refetches; if the total grew, say
  // so rather than letting rows move silently under the pointer (#1705).
  const [newBadge, setNewBadge] = useState<string | null>(null);
  const knownTotalRef = useRef<number | null>(null);
  const returnedRef = useRef(false);
  const { refetch } = query;
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      returnedRef.current = true;
      void refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refetch]);
  useEffect(() => {
    if (!data) return;
    const known = knownTotalRef.current;
    if (returnedRef.current && known !== null) {
      setNewBadge(requestsFreshnessBadge(known, data.meta.total));
    }
    returnedRef.current = false;
    knownTotalRef.current = data.meta.total;
  }, [data]);

  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!focusId || scrolledRef.current || rows.length === 0) return;
    const el = document.getElementById(`request-${focusId}`);
    if (!el) return;
    scrolledRef.current = true;
    el.scrollIntoView({ block: "center" });
  }, [focusId, rows]);

  // ---- selection + batch -------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRows = rows.filter(
    (r) => selected.has(r.id) && isDialogFreeApproval(r),
  );

  // ---- row notes ("Remind sent · next in N h") ----------------------------
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const changedElsewhere = useCallback(() => {
    toast({ title: TOAST.changedElsewhere });
    invalidate();
  }, [invalidate]);

  // ---- approve (requested times / proposal) -------------------------------
  const [approveTarget, setApproveTarget] = useState<InboxRowInput | null>(
    null,
  );
  const [confirmation, setConfirmation] =
    useState<RequestedSlotsConfirmation | null>(null);
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);
  const closeApprove = () => {
    setApproveTarget(null);
    setConfirmation(null);
    attemptKeyRef.current = null;
  };
  const approve = useMutation({
    mutationFn: async ({
      row,
      override,
    }: {
      row: InboxRowInput;
      override: boolean;
    }) => {
      const proposal = answerableProposal(row);
      if (proposal) {
        // Confirming proposed times ANSWERS the proposal (#1163).
        const response = await fetch(
          `/api/appointments/${row.appointmentId}/reschedule/respond`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "accept" }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (response.status === 409 || response.status === 404) {
          return { kind: "stale" as const };
        }
        if (!response.ok) {
          throw new Error(
            errorSentence(body.code, body.error ?? "Could not confirm"),
          );
        }
        return { kind: "done" as const, appointmentId: row.appointmentId };
      }
      const result = await approveRequestedTimes(
        {
          id: row.id,
          type: requestType(row),
          tentativeSlotCount: row.tentativeSlotCount,
        },
        attemptKeyRef,
        override,
      );
      const conflict = classifyRequestedConflict(result);
      if (conflict === "stale" || conflict === "genuine-conflict") {
        return { kind: "stale" as const };
      }
      if (!result.success) {
        throw new Error(
          errorSentence(result.errorCode, result.error ?? "Could not approve"),
        );
      }
      return {
        kind: "done" as const,
        appointmentId: result.data?.[0]?.id ?? null,
      };
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "stale") {
        closeApprove();
        changedElsewhere();
        return;
      }
      toast({ title: TOAST.approved });
      setConfirmation({
        appointmentHref: outcome.appointmentId
          ? `/dashboard/consultant/${consultantProfileId}/appointments/${outcome.appointmentId}`
          : null,
      });
      invalidate();
    },
    onError: (error) => {
      toast({
        title: "Couldn't approve",
        description:
          error instanceof Error ? error.message : "Could not approve",
        variant: "destructive",
      });
    },
  });

  // ---- decline (request or trial) -----------------------------------------
  const [declineTarget, setDeclineTarget] = useState<InboxRowInput | null>(
    null,
  );
  const decline = useMutation({
    mutationFn: async (row: InboxRowInput) => {
      if (row.kind === "trial") {
        const response = await fetch(`/api/trials/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "REJECTED" }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (response.status === 409) return "stale" as const;
        if (!response.ok) {
          throw new Error(
            errorSentence(body.code, body.error ?? "Could not decline"),
          );
        }
        return "done" as const;
      }
      try {
        await declineRequest({ id: row.id, type: requestType(row) });
        return "done" as const;
      } catch (error) {
        // ILLEGAL_TRANSITION: the row left PENDING elsewhere; keep it, refetch.
        if (error instanceof DecisionError && error.status === 409) {
          return "stale" as const;
        }
        throw error;
      }
    },
    onSuccess: (outcome) => {
      setDeclineTarget(null);
      if (outcome === "stale") {
        changedElsewhere();
        return;
      }
      toast({ title: TOAST.declined });
      invalidate();
    },
    onError: (error) => {
      toast({
        title: "Couldn't decline",
        description: errorSentence(
          error instanceof DecisionError ? error.code : undefined,
          error instanceof Error ? error.message : "",
        ),
        variant: "destructive",
      });
    },
  });

  // ---- remind / withdraw (PR-B routes, called by contract) ----------------
  const remind = useMutation({
    mutationFn: async (row: InboxRowInput) => {
      const { status, body } = await postLifecycle(
        `${requestPath(row)}/remind`,
      );
      const nextAllowedAt =
        typeof body.nextAllowedAt === "string"
          ? new Date(body.nextAllowedAt)
          : null;
      if (status === 200 || status === 429) {
        return { row, limited: status === 429, nextAllowedAt };
      }
      throw new Error(
        errorSentence(
          typeof body.code === "string" ? body.code : undefined,
          typeof body.error === "string"
            ? body.error
            : "Could not send a reminder",
        ),
      );
    },
    onSuccess: ({ row, limited, nextAllowedAt }) => {
      if (nextAllowedAt) {
        setNotes((prev) => ({
          ...prev,
          [row.id]: nextReminderLine(nextAllowedAt),
        }));
      }
      toast(
        limited
          ? { title: errorSentence("REMIND_RATE_LIMITED", "") }
          : { title: TOAST.reminderSent },
      );
    },
    onError: (error) => {
      toast({
        title: "Couldn't send a reminder",
        description: error instanceof Error ? error.message : "",
        variant: "destructive",
      });
    },
  });

  const [withdrawTarget, setWithdrawTarget] = useState<InboxRowInput | null>(
    null,
  );
  const withdraw = useMutation({
    mutationFn: async (row: InboxRowInput) => {
      const { status, body } = await postLifecycle(
        `${requestPath(row)}/withdraw-approval`,
      );
      if (status === 200) return "done" as const;
      if (status === 409) return "stale" as const;
      throw new Error(
        errorSentence(
          typeof body.code === "string" ? body.code : undefined,
          typeof body.error === "string" ? body.error : "Could not withdraw",
        ),
      );
    },
    onSuccess: (outcome) => {
      setWithdrawTarget(null);
      if (outcome === "stale") {
        changedElsewhere();
        return;
      }
      toast({ title: TOAST.approvalWithdrawn });
      invalidate();
    },
    onError: (error) => {
      toast({
        title: "Couldn't withdraw",
        description: error instanceof Error ? error.message : "",
        variant: "destructive",
      });
    },
  });

  // ---- trial accept -------------------------------------------------------
  const [trialTarget, setTrialTarget] = useState<TrialAcceptTarget | null>(
    null,
  );

  const onAction = (row: InboxRowInput, action: RowAction) => {
    switch (action.kind) {
      case "approve":
        setApproveTarget(row);
        return;
      case "decline":
      case "trial-decline":
        setDeclineTarget(row);
        return;
      case "remind":
        setBusyId(row.id);
        remind.mutate(row, { onSettled: () => setBusyId(null) });
        return;
      case "withdraw":
        setWithdrawTarget(row);
        return;
      case "pick-time":
        setTrialTarget({
          id: row.id,
          consulteeName: row.requester.name,
          durationMinutes: row.trial?.durationMinutes ?? 30,
        });
        return;
      default:
        return;
    }
  };

  const loading = query.isPending && !data;
  const refreshing = query.isFetching;
  const counts = data?.meta.counts;
  const totalPages = data
    ? Math.max(1, Math.ceil(data.meta.total / data.meta.limit))
    : 1;

  const renderBody = () => {
    if (loading) {
      return (
        <div role="status" aria-live="polite" className="space-y-3">
          <span className="sr-only">Loading requests</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      );
    }
    if (query.isError && !data) {
      const message =
        query.error instanceof Error
          ? query.error.message
          : "Something went wrong.";
      return (
        <div className="rounded-lg border border-border p-6">
          <p className="font-medium text-foreground">
            Couldn&apos;t load requests
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <Button className="mt-4" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon={Inbox}
          title={EMPTY_STATE[params.type].title}
          description={EMPTY_STATE[params.type].body}
        />
      );
    }
    return (
      <>
        <InboxBuckets
          rows={rows}
          flat={chip === "declined"}
          renderRow={(row) => (
            <InboxRow
              key={row.id}
              row={row}
              viewer={viewer}
              selectable={isDialogFreeApproval(row)}
              selected={selected.has(row.id)}
              busy={
                busyId === row.id ||
                (approve.isPending && approveTarget?.id === row.id)
              }
              note={notes[row.id] ?? null}
              focused={focusId === row.id}
              onSelect={(checked) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(row.id);
                  else next.delete(row.id);
                  return next;
                })
              }
              onAction={(action) => onAction(row, action)}
            />
          )}
        />
        {data && data.meta.total > data.meta.limit && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span aria-live="polite">
              Showing {(data.meta.page - 1) * data.meta.limit + 1}&ndash;
              {Math.min(
                data.meta.total,
                data.meta.page * data.meta.limit,
              )} of {data.meta.total}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing || data.meta.page <= 1}
                onClick={() => setParams({ page: data.meta.page - 1 })}
              >
                Prev
              </Button>
              <span className="tabular-nums">
                {data.meta.page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing || data.meta.page >= totalPages}
                onClick={() => setParams({ page: data.meta.page + 1 })}
              >
                Next
              </Button>
            </div>
          </div>
        )}
        <BatchApproveBar
          rows={selectedRows}
          busy={approve.isPending}
          onClear={() => setSelected(new Set())}
          onFinished={() => {
            setSelected(new Set());
            invalidate();
          }}
        />
      </>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={params.type}
          onValueChange={(next) => {
            setSelected(new Set());
            setParams({ type: next as InboxType });
          }}
        >
          <TabsList aria-label="Request type">
            {INBOX_TYPES.map((type) => (
              <TabsTrigger key={type} value={type} className="gap-1.5">
                {TYPE_LABEL[type]}
                {counts && (
                  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                    {counts[type]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <span role="status" aria-live="polite">
            {newBadge && (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5 bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200"
                onClick={() => {
                  setNewBadge(null);
                  void query.refetch();
                }}
              >
                {newBadge} &middot; Refresh
              </Button>
            )}
          </span>
          <InboxSortControl
            value={params.sort}
            disabled={loading}
            onChange={(sort) => setParams({ sort })}
          />
          {/* Refresh stays the truth: it re-reads now, whatever the clock says. */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={refreshing}
            onClick={() => {
              setNewBadge(null);
              void query.refetch();
            }}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
              aria-hidden
            />
            Refresh
          </Button>
        </div>
      </div>

      <InboxChips
        type={params.type}
        active={chip}
        disabled={loading}
        onChange={(next) => {
          setSelected(new Set());
          setParams({ chip: next });
        }}
      />

      {renderBody()}

      <RequestedSlotsDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          // Held while the confirm is in flight (#1705).
          if (!open && !approve.isPending) closeApprove();
        }}
        confirmation={confirmation}
        requestId={approveTarget?.id ?? ""}
        requestType={
          approveTarget
            ? requestType(approveTarget)
            : AppointmentsType.CONSULTATION
        }
        requestedSlots={(() => {
          if (!approveTarget) return [];
          const proposal = answerableProposal(approveTarget);
          const slots = proposal
            ? proposal.proposedTimes.filter((t) => t.round === proposal.round)
            : approveTarget.slots;
          return slots.map((s) => toStampDate(s.startsAt).toISOString());
        })()}
        requestedSlotsWithStatus={approveTarget?.slots.map((s) => ({
          startsAt: toStampDate(s.startsAt).toISOString(),
          isTentative: s.isTentative,
          completionStatus: s.completionStatus,
        }))}
        schedulingPeriod={
          approveTarget?.schedulingPeriod
            ? {
                startDate: toStampDate(approveTarget.schedulingPeriod.start),
                endDate: toStampDate(approveTarget.schedulingPeriod.end),
              }
            : undefined
        }
        confirming={approve.isPending}
        allocateHref={
          approveTarget?.hrefs.allocate ??
          `/dashboard/consultant/${consultantProfileId}/requests`
        }
        appointmentHrefFor={(appointmentId) =>
          `/dashboard/consultant/${consultantProfileId}/appointments/${appointmentId}`
        }
        rescheduleNeedsAllocator={
          !!approveTarget &&
          approveTarget.rescheduledSlotCount > 0 &&
          !answerableProposal(approveTarget)
        }
        onConfirm={async (override) => {
          if (approveTarget)
            await approve
              .mutateAsync({ row: approveTarget, override })
              .catch(() => undefined);
        }}
        onCancel={closeApprove}
      />

      <AlertDialog
        open={declineTarget !== null}
        onOpenChange={(open) => {
          if (!open && !decline.isPending) setDeclineTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {declineTarget?.requester.name} asked for &ldquo;
              {declineTarget?.planTitle}
              &rdquo;. They are told, and anything already paid is returned in
              full.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={decline.isPending}>
              Keep request
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={decline.isPending}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600 dark:bg-red-700 dark:hover:bg-red-600"
              onClick={(event) => {
                event.preventDefault();
                if (declineTarget) decline.mutate(declineTarget);
              }}
            >
              {decline.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Declining…
                </>
              ) : (
                "Decline"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open && !withdraw.isPending) setWithdrawTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this approval?</AlertDialogTitle>
            <AlertDialogDescription>
              {withdrawTarget?.requester.name}&apos;s pay link stops working and
              the held times are released. They are told and can request again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>
              Keep waiting
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={withdraw.isPending}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600 dark:bg-red-700 dark:hover:bg-red-600"
              onClick={(event) => {
                event.preventDefault();
                if (withdrawTarget) withdraw.mutate(withdrawTarget);
              }}
            >
              {withdraw.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Withdrawing…
                </>
              ) : (
                "Withdraw approval"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TrialAcceptDialog
        consultantId={consultantProfileId}
        target={trialTarget}
        onOpenChange={(open) => {
          if (!open) setTrialTarget(null);
        }}
        onAccepted={() => {
          setTrialTarget(null);
          invalidate();
        }}
      />
    </div>
  );
}
