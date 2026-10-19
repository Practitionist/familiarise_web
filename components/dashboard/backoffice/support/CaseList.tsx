"use client";

import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Inbox, MoreHorizontal } from "lucide-react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { isEditableTarget } from "@/components/dashboard/CollapsibleSidebar";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ResponsiveTable,
  useRowSelection,
  type ResponsiveColumn,
  type TableSort,
} from "@/components/ui/responsive-table";
import { formatPaise } from "@/lib/backoffice/rupees";
import { caseStatus, ticketPriority } from "@/lib/labels/backoffice-labels";
import { shortAge } from "@/lib/support/case-format";
import { CASE_TOPIC_LABEL } from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import { INBOX_FILTER_KEYS, INBOX_PAGE_SIZE } from "@/lib/support/inbox-query";
import { slaHint, slaStatusBadge } from "@/lib/support/sla-hint";
import {
  InboxListResponseSchema,
  type CaseBulkAction,
  type CaseBulkOutcome,
} from "@/schemas/support-inbox";
import type { InboxRow } from "@/types/support-case";

import { CaseBulkBar, CaseBulkOutcomes } from "./CaseBulkBar";
import { CaseShortcutHelp } from "./CaseShortcuts";
import {
  INBOX_SEARCH_INPUT_ID,
  useInboxListParams,
} from "./useInboxListParams";
import { useCaseBulkAction } from "./useCaseBulkAction";

/** The audit row's reason when the operator did not write one. */
const DEFAULT_REASON: Record<CaseBulkAction, string> = {
  ASSIGN_TO_ME: "Assigned to me from the Support queue",
  RESOLVE: "Resolved from the Support queue",
};

function caseHref(basePath: string, key: string, search: string): string {
  return `${basePath}/support/${key}${search ? `?${search}` : ""}`;
}

/**
 * The Support queue: one server page of cases as a sortable, selectable
 * table. The URL carries the search, the filters, the sort and the page, so
 * the list is a view over the link — share it, reload it, and it comes back
 * the same.
 */
export function CaseList({
  activeKey,
}: Readonly<{ activeKey: string | null }>) {
  const { basePath, can } = useBackofficeCapability();
  const list = useInboxListParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const search = searchParams.toString();
  /**
   * Affordance only: the bulk route and the inbox route both gate on
   * `tickets.manage` in the same permission matrix, so the server is the
   * door and this is only about what the operator is offered.
   */
  const canAct = can("tickets.manage");

  const query = new URLSearchParams();
  if (list.q) query.set("q", list.q);
  if (list.page > 1) query.set("page", String(list.page));
  if (list.sort) {
    query.set(
      "sort",
      list.sort.dir === "desc" ? `-${list.sort.key}` : list.sort.key,
    );
  }
  for (const key of INBOX_FILTER_KEYS) {
    const value = list.filters[key];
    if (value) query.set(key, value);
  }
  const qs = query.toString();

  const cases = useQuery({
    queryKey: ["support-inbox", qs],
    queryFn: async () => {
      const res = await fetch(`/api/staff/support-inbox?${qs}`);
      if (!res.ok) await throwSupportError(res, "support inbox load");
      return InboxListResponseSchema.parse(await res.json());
    },
    placeholderData: keepPreviousData,
  });

  const bulk = useCaseBulkAction();
  const [outcomes, setOutcomes] = useState<CaseBulkOutcome[] | null>(null);
  const [reason, setReason] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  const rows = useMemo(() => cases.data?.rows ?? [], [cases.data]);
  const selection = useRowSelection(rows.map((r) => r.key));

  const runBulk = useCallback(
    async (action: CaseBulkAction, keys: string[]) => {
      if (keys.length === 0) return;
      setOutcomes(null);
      try {
        const result = await bulk.mutateAsync({
          action,
          reason: reason.trim() || DEFAULT_REASON[action],
          caseKeys: keys,
        });
        setOutcomes(result);
        selection.clear();
      } catch {
        // The mutation's own toast already said what went wrong.
      }
    },
    [bulk, reason, selection],
  );

  const onSortChange = useCallback(
    (next: TableSort) => {
      const current = list.sort;
      // The activity column reads newest-first, so the first click on it starts
      // descending; every other column starts ascending.
      const dir =
        current && current.key === next.key
          ? next.dir
          : next.key === "activity"
            ? "desc"
            : next.dir;
      list.setSort({ key: next.key, dir });
    },
    [list],
  );

  /** The row the `j`/`k` shortcuts move from: the open case, else the first. */
  const currentIndex = rows.findIndex((r) => r.key === activeKey);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from =
        currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : rows.length;
      const next = Math.min(Math.max(from + delta, 0), rows.length - 1);
      const row = rows[next];
      if (!row) return;
      router.push(caseHref(basePath, row.key, search));
    },
    [basePath, currentIndex, rows, router, search],
  );

  const assignToMe = useCallback(() => {
    if (!canAct) return;
    // The selection, or the case open in the pane. The server reads the row's
    // own version, so a case that is not on this page can still be assigned.
    const keys =
      selection.selectedIds.size > 0
        ? [...selection.selectedIds]
        : activeKey
          ? [activeKey]
          : [];
    void runBulk("ASSIGN_TO_ME", keys);
  }, [activeKey, canAct, runBulk, selection.selectedIds]);

  /**
   * The queue's keyboard layer. The handler sits on the queue container, so
   * it only ever sees a keystroke typed while the focus was inside the queue
   * (WCAG 2.1.4): a character key never fires while the operator is typing
   * in a field, and moving the focus out of the queue turns every shortcut
   * off.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    switch (event.key) {
      case "/":
        event.preventDefault();
        document.getElementById(INBOX_SEARCH_INPUT_ID)?.focus();
        break;
      case "j":
        event.preventDefault();
        move(1);
        break;
      case "k":
        event.preventDefault();
        move(-1);
        break;
      case "a":
        event.preventDefault();
        assignToMe();
        break;
      case "?":
        event.preventDefault();
        setHelpOpen(true);
        break;
      default:
        break;
    }
  };

  const columns = useMemo<ResponsiveColumn<InboxRow>[]>(
    () => [
      {
        key: "reference",
        header: "Reference",
        primary: true,
        sortable: true,
        cell: (row) => (
          <span className="font-medium tabular-nums text-foreground">
            {row.reference ?? row.key}
          </span>
        ),
      },
      {
        key: "subject",
        header: "Subject",
        sortable: true,
        cell: (row) => (
          <span className="block max-w-[18rem]">
            <span className="block truncate" title={row.subject}>
              {row.subject}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {row.requester.name ?? "Unknown user"}
            </span>
          </span>
        ),
      },
      {
        key: "topic",
        header: "Topic",
        cell: (row) => (
          <span className="text-xs text-muted-foreground">
            {CASE_TOPIC_LABEL[row.topic]}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        cell: (row) => (
          <StatusBadge {...caseStatus(row.kind, row.status)} size="sm" />
        ),
      },
      {
        key: "priority",
        header: "Priority",
        cell: (row) => (
          <StatusBadge {...ticketPriority(row.priority)} size="sm" />
        ),
      },
      {
        key: "assignee",
        header: "Assignee",
        sortable: true,
        cell: (row) =>
          row.assignee?.name ? (
            <span className="truncate">{row.assignee.name}</span>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          ),
      },
      {
        key: "amount",
        header: "Amount",
        cell: (row) => (
          <span className="tabular-nums">
            {row.amount === null
              ? "—"
              : formatPaise(row.amount, row.currency ?? "INR")}
          </span>
        ),
      },
      {
        key: "sla",
        header: "SLA / age",
        sortable: true,
        cell: (row) => {
          const status = slaStatusBadge(row.sla);
          const hint = slaHint(row.sla);
          return (
            <span className="flex flex-col gap-0.5">
              {status && <StatusBadge {...status} size="sm" />}
              {hint && (
                <span className="text-[11px] text-muted-foreground">
                  {hint.label}
                </span>
              )}
              {row.channel !== "HUMAN" && (
                <span className="text-[11px] text-muted-foreground">
                  Self-serve
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "activity",
        header: "Last activity",
        sortable: true,
        cell: (row) => (
          <time
            dateTime={row.lastActivityAt}
            className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          >
            {shortAge(row.lastActivityAt)}
          </time>
        ),
      },
    ],
    [],
  );

  if (cases.isError && !cases.data) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-destructive">
        Couldn&apos;t load the inbox.{" "}
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={() => void cases.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="Support queue"
      onKeyDown={onKeyDown}
      className="min-w-0 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {cases.data
            ? `${cases.data.total} case${cases.data.total === 1 ? "" : "s"} in this view`
            : "Loading the queue…"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8"
          aria-keyshortcuts="?"
          onClick={() => setHelpOpen(true)}
        >
          Shortcuts
        </Button>
      </div>

      <ResponsiveTable<InboxRow>
        caption="Support cases in the current view"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.key}
        getRowHref={(row) => caseHref(basePath, row.key, search)}
        selectable={canAct}
        selectedIds={selection.selectedIds}
        allSelected={selection.allSelected}
        onToggle={selection.onToggle}
        onToggleAll={selection.onToggleAll}
        sort={list.sort}
        onSortChange={onSortChange}
        isLoading={cases.isLoading && !cases.data}
        empty={
          <EmptyState
            icon={Inbox}
            title="No cases here"
            description="Nothing matches this view and these filters."
          />
        }
        rowActions={
          canAct
            ? (row) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 scroll-mb-16"
                      aria-label={`Actions for ${row.reference ?? row.key}`}
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => void runBulk("ASSIGN_TO_ME", [row.key])}
                    >
                      Assign to me
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void runBulk("RESOLVE", [row.key])}
                    >
                      Resolve
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            : undefined
        }
        bulkBar={
          canAct ? (
            <CaseBulkBar
              count={selection.selectedIds.size}
              busy={bulk.isPending}
              reason={reason}
              onReasonChange={setReason}
              onAssignToMe={() =>
                void runBulk("ASSIGN_TO_ME", [...selection.selectedIds])
              }
              onResolve={() =>
                void runBulk("RESOLVE", [...selection.selectedIds])
              }
              onClearSelection={selection.clear}
              footer={
                outcomes ? <CaseBulkOutcomes outcomes={outcomes} /> : undefined
              }
            />
          ) : undefined
        }
      />

      <TablePagination
        page={list.page}
        pageSize={INBOX_PAGE_SIZE}
        total={cases.data?.total ?? 0}
        onPageChange={list.setPage}
      />
      {cases.data?.truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the most recent cases. Narrow the filters to reach older ones.
        </p>
      )}
      <CaseShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </section>
  );
}
