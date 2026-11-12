"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
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
  isCursorSort,
  nextInboxSearch,
  readInboxParams,
  toStampDate,
  type InboxChip,
  type InboxParamsPatch,
  type InboxRowInput,
  type InboxType,
  type RequestsInboxPayload,
} from "@/lib/dashboard/requests-inbox-state";
import { requestsFreshnessBadge } from "@/lib/scheduling/requestsFreshness";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import { cn } from "@/utils/tailwind";
import { replaceUrl } from "@/lib/navigation/history";

import { BatchApproveBar } from "./BatchApproveBar";
import { InboxBuckets } from "./InboxBuckets";
import { InboxChips } from "./InboxChips";
import {
  InboxRow,
  answerableProposal,
  formatDateTime,
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
  RANKED_WINDOW_NOTE,
  TOAST,
  TYPE_LABEL,
  approvedToast,
  errorSentence,
  nextReminderLine,
  proposalAnswerToast,
} from "./labels";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import {
  DecisionError,
  approveRequestedTimes,
  classifyProposalConflict,
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

/** Answering a reschedule from the inbox: turn the client's down, or take yours back. */
type ProposalAnswer = "keep-original" | "withdraw-proposal";

/** The released time a reschedule would move away from, for the dialog copy. */
function originalTimeOf(row: InboxRowInput, viewer: ViewerZone): string {
  const released = row.slots.find((s) => s.completionStatus === "RESCHEDULED");
  return released
    ? formatDateTime(released.startsAt, viewer)
    : "its original time";
}

/**
 * Tabs, chips, sort, page and cursor live in the URL. Writes go through `replaceUrl`,
 * which the App Router syncs into `useSearchParams`: the URL changes
 * synchronously and no server round trip re-renders the page for a filter
 * click.
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
      // The live URL, not the `searchParams` closure: two writes before the
      // router sync lands would otherwise both start from the same value.
      const qs = nextInboxSearch(window.location.search, patch);
      replaceUrl(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname],
  );
  return { params, setParams };
}

/**
 * The consultant Requests inbox: type tabs, chips, sort and deadline buckets
 * over `readRequestsInbox`, every word from the presentation layer, one
 * primary action per row. State lives in the URL; the RSC page seeds the
 * query and this component keeps it fresh (30 s stale, cache-first: no
 * mount/focus refetch — manual Refresh is the truth).
 */
export function RequestsInbox({
  consultantProfileId,
  orgScope = "personal",
  viewerZone,
}: Readonly<RequestsInboxProps>) {
  const { params, setParams } = useInboxUrlState();
  // A breadcrumb / link may name one row; it is highlighted and scrolled to once.
  const focusId = params.focus;
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
    after: params.after,
    focus: params.focus,
  };
  const queryKey = inboxQueryKey(queryArgs);
  const queryString = inboxQueryString(queryArgs);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchInbox(queryString),
    staleTime: 30_000,
    // Perf: cache-first tab switches. The old `always` refetched even with
    // fresh cache, so every mount felt like a reload. `true` (stale-only)
    // shows cache instantly and background-refetches only when >30s old;
    // `false` would pin stale data forever. Focus stays off — the throttled
    // visibility listener below owns return-to-tab freshness.
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    // A failing tab should show its error in seconds, not after the
    // provider's two retries.
    retry: 1,
  });
  const { data, dataUpdatedAt, isPlaceholderData } = query;
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

  // "N new · Refresh": a return to the tab (throttled to a stale cache) reads
  // the inbox into a pending slot without touching the rows on screen. A
  // changed total offers the swap; an unchanged one swaps in silently.
  const [newBadge, setNewBadge] = useState<string | null>(null);
  const pendingRef = useRef<RequestsInboxPayload | null>(null);
  const currentRef = useRef({ key: queryKey, qs: queryString });
  const lastFetchRef = useRef<number>(Date.now());
  useEffect(() => {
    currentRef.current = { key: queryKey, qs: queryString };
  });
  useEffect(() => {
    if (dataUpdatedAt) lastFetchRef.current = dataUpdatedAt;
  }, [dataUpdatedAt]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchRef.current < 30_000) return;
      lastFetchRef.current = Date.now();
      const { key, qs } = currentRef.current;
      void fetchInbox(qs)
        .then((fresh) => {
          if (currentRef.current.qs !== qs) return;
          const shown = queryClient.getQueryData<RequestsInboxPayload>(key);
          const badge = shown
            ? requestsFreshnessBadge(shown.meta.total, fresh.meta.total)
            : null;
          if (badge) {
            pendingRef.current = fresh;
            setNewBadge(badge);
          } else {
            queryClient.setQueryData(key, fresh);
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);
  const applyPending = () => {
    setNewBadge(null);
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) queryClient.setQueryData(queryKey, pending);
    else void query.refetch();
  };
  // A pending payload belongs to the view it was read for.
  useEffect(() => {
    pendingRef.current = null;
    setNewBadge(null);
  }, [queryString]);

  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!focusId || scrolledRef.current || rows.length === 0) return;
    const el = document.getElementById(`request-${focusId}`);
    if (!el) return;
    scrolledRef.current = true;
    el.scrollIntoView({ block: "center" });
  }, [focusId, rows]);

  // Tab switches are non-urgent: keep old rows on screen (keepPreviousData
  // above) while the new cohort streams in, instead of blocking the click.
  const [, startTransition] = useTransition();
  const setParamsTransition = useCallback(
    (patch: InboxParamsPatch) => {
      startTransition(() => setParams(patch));
    },
    [setParams],
  );

  // Hover/intent prefetch for sibling tabs + chips (TanStack prefetching
  // best practice: onMouseEnter/onFocus, staleTime-guarded). Hovering across
  // several chips must not queue one full inbox read per chip ahead of the
  // click: intent is debounced 150ms and at most 2 prefetches fly at once.
  const prefetchedKeysRef = useRef(new Set<string>());
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(0);
  const MAX_PREFETCH_IN_FLIGHT = 2;
  useEffect(
    () => () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    },
    [],
  );
  const prefetchInbox = useCallback(
    (type: InboxType, chip: InboxChip | null) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = setTimeout(() => {
        const args = {
          consultantProfileId,
          scope: orgScope,
          type,
          chip,
          sort: params.sort,
          page: 1,
          after: null,
          focus: null,
        };
        const key = inboxQueryKey(args).join("|");
        if (prefetchedKeysRef.current.has(key)) return;
        if (inFlightRef.current >= MAX_PREFETCH_IN_FLIGHT) return;
        prefetchedKeysRef.current.add(key);
        setTimeout(() => prefetchedKeysRef.current.delete(key), 5000);
        inFlightRef.current += 1;
        void queryClient
          .prefetchQuery({
            queryKey: inboxQueryKey(args),
            queryFn: () => fetchInbox(inboxQueryString(args)),
            staleTime: 30_000,
          })
          .catch(() => undefined)
          .finally(() => {
            inFlightRef.current = Math.max(0, inFlightRef.current - 1);
          });
      }, 150);
    },
    [consultantProfileId, orgScope, params.sort, queryClient],
  );

  // ---- selection + batch -------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const selectedRows = rows.filter(
    (r) => selected.has(r.id) && isDialogFreeApproval(r),
  );

  // ---- row notes ("Remind sent · next in N h") ----------------------------
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const changedElsewhere = useCallback(
    (message: string = TOAST.changedElsewhere) => {
      toast({ title: message });
      invalidate();
    },
    [invalidate],
  );

  // ---- approve (requested times / proposal) -------------------------------
  const [approveTarget, setApproveTarget] = useState<InboxRowInput | null>(
    null,
  );
  const [confirmation, setConfirmation] =
    useState<RequestedSlotsConfirmation | null>(null);
  // A retryable refusal shown inside the dialog; `attempt` re-checks the times.
  const [refusal, setRefusal] = useState<{
    message: string;
    attempt: number;
  } | null>(null);
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);
  const closeApprove = () => {
    setApproveTarget(null);
    setConfirmation(null);
    setRefusal(null);
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
        const response = await fetchWithIdentity(
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
        const conflict = classifyProposalConflict(response.status, body.code);
        if (conflict === "stay-open") {
          return {
            kind: "retry" as const,
            message: errorSentence(
              body.code,
              body.error ?? "Those times can't be booked right now.",
            ),
          };
        }
        if (conflict === "stale") {
          return {
            kind: "stale" as const,
            message: errorSentence(body.code, TOAST.changedElsewhere),
          };
        }
        if (!response.ok) {
          throw new Error(
            errorSentence(body.code, body.error ?? "Could not confirm"),
          );
        }
        return {
          kind: "done" as const,
          appointmentId: row.appointmentId,
          awaitingPayment: false,
          payExpiresAt: null,
        };
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
      // The request moved on: close, refresh, say why plainly. A slot taken,
      // a busy lock or a co-host clash leaves it allocatable: stay and retry.
      const conflict = classifyRequestedConflict(result);
      if (conflict === "stay-open") {
        return {
          kind: "retry" as const,
          message: errorSentence(
            result.errorCode,
            result.error ?? "Those times can't be booked right now.",
          ),
        };
      }
      if (conflict !== null) {
        return {
          kind: "stale" as const,
          message: errorSentence(result.errorCode, TOAST.changedElsewhere),
        };
      }
      if (!result.success) {
        throw new Error(
          errorSentence(result.errorCode, result.error ?? "Could not approve"),
        );
      }
      return {
        kind: "done" as const,
        appointmentId: result.data?.[0]?.id ?? null,
        awaitingPayment: result.awaitingPayment === true,
        payExpiresAt: result.payExpiresAt ?? null,
      };
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "stale") {
        closeApprove();
        changedElsewhere(outcome.message);
        return;
      }
      if (outcome.kind === "retry") {
        // A refused attempt is spent: the next confirm is a new one.
        attemptKeyRef.current = null;
        setRefusal((prev) => ({
          message: outcome.message,
          attempt: (prev?.attempt ?? 0) + 1,
        }));
        invalidate();
        return;
      }
      setRefusal(null);
      // No optimistic removal: the refetch moves an unpaid approval to the
      // "Awaiting payment" chip (the read includes APPROVED_PENDING_PAYMENT).
      toast({ title: approvedToast(outcome, { zone: viewer.zone }) });
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
    onSettled: invalidate,
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

  // ---- answer a reschedule (keep the original / withdraw mine) -------------
  const [answerTarget, setAnswerTarget] = useState<{
    row: InboxRowInput;
    answer: ProposalAnswer;
  } | null>(null);
  const answerProposal = useMutation({
    mutationFn: async ({
      row,
      answer,
    }: {
      row: InboxRowInput;
      answer: ProposalAnswer;
    }) => {
      const base = `/api/appointments/${encodeURIComponent(row.appointmentId ?? "")}/reschedule`;
      const response = await fetchWithIdentity(
        answer === "keep-original" ? `${base}/respond` : `${base}/withdraw`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body:
            answer === "keep-original"
              ? JSON.stringify({ action: "decline" })
              : undefined,
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        outcome?: string;
      };
      if (response.ok) {
        return { kind: "done" as const, answer, outcome: body.outcome };
      }
      if (classifyProposalConflict(response.status, body.code) === "stale") {
        return { kind: "stale" as const, answer };
      }
      throw new Error(
        errorSentence(body.code, body.error ?? "Could not update the request"),
      );
    },
    onSuccess: (outcome) => {
      setAnswerTarget(null);
      if (outcome.kind === "stale") {
        changedElsewhere();
        return;
      }
      toast({ title: proposalAnswerToast(outcome.answer, outcome.outcome) });
      invalidate();
    },
    onError: (error) => {
      setAnswerTarget(null);
      toast({
        title: "Couldn't update the request",
        description: error instanceof Error ? error.message : "",
        variant: "destructive",
      });
      invalidate();
    },
  });

  // ---- trial accept -------------------------------------------------------
  const [trialTarget, setTrialTarget] = useState<TrialAcceptTarget | null>(
    null,
  );

  const onAction = (row: InboxRowInput, action: RowAction) => {
    switch (action.kind) {
      case "approve":
      case "accept-proposal":
        setApproveTarget(row);
        return;
      case "keep-original":
      case "withdraw-proposal":
        setAnswerTarget({ row, answer: action.kind });
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
          consulteeUserId: row.trial?.consulteeUserId,
          durationMinutes: row.trial?.durationMinutes ?? 30,
        });
        return;
      default:
        return;
    }
  };

  const loading = query.isPending && !data;
  const refreshing = query.isFetching;
  // The error card must not also blank the tab counts.
  const [lastCounts, setLastCounts] = useState(data?.meta.counts);
  useEffect(() => {
    if (data?.meta.counts) setLastCounts(data.meta.counts);
  }, [data]);
  const counts = data?.meta.counts ?? lastCounts;
  const timeSort = isCursorSort(params.sort) || params.sort === "deadline";
  const totalPages = data
    ? Math.max(1, Math.ceil(data.meta.windowSize / data.meta.limit))
    : 1;

  // Cursor pages go forward by the server's cursor; back by the ones we came through.
  const [cursorTrail, setCursorTrail] = useState<(string | null)[]>([]);
  useEffect(() => {
    setCursorTrail([]);
  }, [params.type, params.chip, params.sort]);
  const nextCursorPage = (cursor: string) => {
    setCursorTrail((trail) => [...trail, params.after]);
    setParamsTransition({ after: cursor });
  };
  const prevCursorPage = () => {
    const previous = cursorTrail[cursorTrail.length - 1] ?? null;
    setCursorTrail((trail) => trail.slice(0, -1));
    setParamsTransition({ after: previous });
  };

  const renderPager = (meta: RequestsInboxPayload["meta"]) => {
    if (meta.paging === "cursor") {
      if (meta.nextCursor === null && params.after === null) return null;
      // A reload or deep link lands mid-list with no trail: no start offset.
      const from =
        params.after === null || cursorTrail.length > 0
          ? cursorTrail.length * meta.limit + 1
          : null;
      return (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span aria-live="polite">
            {from === null
              ? `Showing ${rows.length} of ${meta.total}`
              : `Showing ${from}–${from + rows.length - 1} of ${meta.total}`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || params.after === null}
              onClick={prevCursorPage}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || meta.nextCursor === null}
              onClick={() => meta.nextCursor && nextCursorPage(meta.nextCursor)}
            >
              Next
            </Button>
          </div>
        </div>
      );
    }
    const truncated = meta.total > meta.windowSize;
    if (meta.windowSize <= meta.limit && !truncated) return null;
    return (
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span aria-live="polite">
          {truncated
            ? RANKED_WINDOW_NOTE(meta.windowSize, meta.total, params.sort)
            : `Showing ${(meta.page - 1) * meta.limit + 1}–${Math.min(
                meta.windowSize,
                meta.page * meta.limit,
              )} of ${meta.windowSize}`}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || meta.page <= 1}
              onClick={() => setParamsTransition({ page: meta.page - 1 })}
            >
              Prev
            </Button>
            <span className="tabular-nums">
              {meta.page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || meta.page >= totalPages}
              onClick={() => setParamsTransition({ page: meta.page + 1 })}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    );
  };

  const renderBody = () => {
    if (query.isError && (!data || isPlaceholderData)) {
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
    // Placeholder rows belong to the previous tab, so an empty
    // placeholder must not render this tab's empty state.
    if (loading || (isPlaceholderData && rows.length === 0)) {
      return (
        <div role="status" aria-live="polite" className="space-y-3">
          <span className="sr-only">Loading requests</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
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
      <div
        aria-busy={isPlaceholderData}
        className={cn(
          "space-y-4",
          isPlaceholderData && "opacity-60 transition-opacity",
        )}
      >
        <InboxBuckets
          rows={rows}
          // Time sorts read top to bottom in time order; buckets would reorder them.
          flat={chip === "declined" || timeSort}
          totals={data?.meta.bucketTotals ?? null}
          renderRow={(row) => (
            <InboxRow
              key={row.id}
              row={row}
              viewer={viewer}
              selectable={isDialogFreeApproval(row)}
              selected={selected.has(row.id)}
              busy={
                busyId === row.id ||
                (approve.isPending && approveTarget?.id === row.id) ||
                (batchRunning && selected.has(row.id))
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
        {data && renderPager(data.meta)}
        <BatchApproveBar
          rows={selectedRows}
          busy={approve.isPending}
          onRunningChange={setBatchRunning}
          onClear={() => setSelected(new Set())}
          onFinished={() => {
            setSelected(new Set());
            invalidate();
          }}
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={params.type}
          onValueChange={(next) => {
            setSelected(new Set());
            setParamsTransition({ type: next as InboxType });
          }}
        >
          <TabsList aria-label="Request type">
            {INBOX_TYPES.map((type) => (
              <TabsTrigger
                key={type}
                value={type}
                className="gap-1.5"
                onMouseEnter={() => prefetchInbox(type, null)}
                onFocus={() => prefetchInbox(type, null)}
              >
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
                onClick={applyPending}
              >
                {newBadge} &middot; Refresh
              </Button>
            )}
          </span>
          <InboxSortControl
            value={params.sort}
            disabled={loading}
            onChange={(sort) => setParamsTransition({ sort })}
          />
          {/* Refresh stays the truth: it re-reads now, whatever the clock says. */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={refreshing}
            onClick={() => {
              setNewBadge(null);
              pendingRef.current = null;
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
          setParamsTransition({ chip: next });
        }}
        onHoverChip={(c) => prefetchInbox(params.type, c)}
      />

      {renderBody()}

      <RequestedSlotsDialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          // Held while the confirm is in flight (#1705).
          if (!open && !approve.isPending) closeApprove();
        }}
        confirmation={confirmation}
        refusal={refusal}
        requestId={approveTarget?.id ?? ""}
        requestType={
          approveTarget
            ? requestType(approveTarget)
            : AppointmentsType.CONSULTATION
        }
        requestedSlots={(() => {
          if (!approveTarget) return [];
          const proposal = answerableProposal(approveTarget);
          const slots = proposal ? proposal.proposedTimes : approveTarget.slots;
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

      <AlertDialog
        open={answerTarget !== null}
        onOpenChange={(open) => {
          if (!open && !answerProposal.isPending) setAnswerTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {answerTarget?.answer === "withdraw-proposal"
                ? "Withdraw your request?"
                : "Keep the original time?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {answerTarget?.answer === "withdraw-proposal"
                ? `${answerTarget.row.requester.name}'s booking goes back to ${originalTimeOf(answerTarget.row, viewer)}, if that time is still free.`
                : answerTarget
                  ? `We'll tell ${answerTarget.row.requester.name} you can't do the new time. Their booking stays at ${originalTimeOf(answerTarget.row, viewer)}. Nothing is refunded or cancelled.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={answerProposal.isPending}>
              Back
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={answerProposal.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (answerTarget) answerProposal.mutate(answerTarget);
              }}
            >
              {answerProposal.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : answerTarget?.answer === "withdraw-proposal" ? (
                "Withdraw my request"
              ) : (
                "Keep the original time"
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
