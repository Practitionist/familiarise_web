"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Skeleton } from "@/components/ui/skeleton";
import { useListParams } from "@/hooks/useListParams";
import { caseStatus } from "@/lib/labels/backoffice-labels";
import { shortAge } from "@/lib/support/case-format";
import { CASE_TOPIC_LABEL } from "@/lib/support/case-topic";
import { throwSupportError } from "@/lib/support/error-copy";
import { INBOX_FILTER_KEYS, INBOX_PAGE_SIZE } from "@/lib/support/inbox-query";
import { slaHint } from "@/lib/support/sla-hint";
import type { InboxListResponse, InboxRow } from "@/types/support-case";
import { cn } from "@/utils/tailwind";

function CaseRow({
  row,
  href,
  active,
}: Readonly<{ row: InboxRow; href: string; active: boolean }>) {
  const sla = slaHint(row.sla);
  const selfServe = row.kind === "thread" && row.channel !== "HUMAN";
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active && "bg-muted",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {row.requester.name ?? row.requester.email ?? "Unknown user"}
          </span>
          <time
            dateTime={row.lastActivityAt}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {shortAge(row.lastActivityAt)}
          </time>
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {row.subject}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {CASE_TOPIC_LABEL[row.topic]}
          </span>
          <StatusBadge {...caseStatus(row.kind, row.status)} size="sm" />
          {selfServe && (
            <StatusBadge label="Self-serve" tone="neutral" variant="dot" />
          )}
          {sla && <StatusBadge {...sla} variant="dot" />}
        </div>
      </Link>
    </li>
  );
}

/** #1527 — the inbox's list pane: one server page of merged cases. */
export function CaseList({
  activeKey,
}: Readonly<{ activeKey: string | null }>) {
  const { basePath } = useBackofficeCapability();
  const list = useListParams({ filterKeys: INBOX_FILTER_KEYS });
  const search = useSearchParams().toString();

  const query = new URLSearchParams();
  if (list.q) query.set("q", list.q);
  if (list.page > 1) query.set("page", String(list.page));
  for (const key of INBOX_FILTER_KEYS) {
    const value = list.filters[key];
    if (value) query.set(key, value);
  }
  const qs = query.toString();

  const cases = useQuery({
    queryKey: ["support-inbox", qs],
    queryFn: async (): Promise<InboxListResponse> => {
      const res = await fetch(`/api/staff/support-inbox?${qs}`);
      if (!res.ok) await throwSupportError(res, "support inbox load");
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const caseHref = (key: string) =>
    `${basePath}/support/${key}${search ? `?${search}` : ""}`;

  if (cases.isError && !cases.data) {
    return (
      <ErrorState
        title="Couldn't load the inbox"
        onRetry={() => void cases.refetch()}
      />
    );
  }
  if (!cases.data) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  const { rows, total, truncated } = cases.data;
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No cases here"
          description="Nothing matches this view and these filters."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {rows.map((row) => (
            <CaseRow
              key={row.key}
              row={row}
              href={caseHref(row.key)}
              active={row.key === activeKey}
            />
          ))}
        </ul>
      )}
      <TablePagination
        page={list.page}
        pageSize={INBOX_PAGE_SIZE}
        total={total}
        onPageChange={list.setPage}
      />
      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the most recent cases. Narrow the filters to reach older ones.
        </p>
      )}
    </div>
  );
}
