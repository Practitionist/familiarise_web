"use client";

/**
 * Org Support › Organization requests (#1527): platform requests members
 * tagged "About: this org". Subject and metadata only (ADR 20).
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useListParams } from "@/hooks/useListParams";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { ISSUE_TYPE_LABELS } from "@/utils/supportTicketUrl";

const PAGE_SIZE = 20;

interface OrgTicketRow {
  id: string;
  referenceNumber: string | null;
  title: string;
  issueType: string | null;
  category: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  requesterName: string | null;
}

interface OrgTicketsPage {
  data: OrgTicketRow[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_TONE: Record<string, Tone> = {
  OPEN: "caution",
  IN_PROGRESS: "info",
  ESCALATED: "info",
  ON_HOLD: "caution",
  RESOLVED: "success",
  CLOSED: "neutral",
};

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const COLUMNS: ResponsiveColumn<OrgTicketRow>[] = [
  {
    key: "subject",
    header: "Subject",
    primary: true,
    cell: (t) => (
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground">
          {t.title}
        </span>
        {t.referenceNumber && (
          <span className="block font-mono text-[11px] text-muted-foreground">
            {t.referenceNumber}
          </span>
        )}
      </span>
    ),
  },
  {
    key: "category",
    header: "Category",
    cell: (t) => {
      const label =
        (t.issueType &&
          ISSUE_TYPE_LABELS[t.issueType as keyof typeof ISSUE_TYPE_LABELS]) ??
        (t.category ? humanizeEnum(t.category) : "—");
      return <span className="text-muted-foreground">{label}</span>;
    },
  },
  {
    key: "status",
    header: "Status",
    cell: (t) => (
      <StatusBadge
        label={humanizeEnum(t.status)}
        tone={STATUS_TONE[t.status] ?? "neutral"}
        size="sm"
      />
    ),
  },
  {
    key: "requester",
    header: "Requested by",
    cell: (t) => (
      <span className="text-muted-foreground">{t.requesterName ?? "—"}</span>
    ),
  },
  {
    key: "created",
    header: "Created",
    cell: (t) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {DATE.format(new Date(t.createdAt))}
      </span>
    ),
  },
  {
    key: "updated",
    header: "Updated",
    cell: (t) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {DATE.format(new Date(t.updatedAt))}
      </span>
    ),
  },
];

export function OrgSupportRequests({ orgId }: Readonly<{ orgId: string }>) {
  const { page, setPage } = useListParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["org-support-tickets", orgId, page],
    queryFn: async (): Promise<OrgTicketsPage> => {
      const res = await fetch(
        `/api/organizations/${orgId}/support-tickets?page=${page}&pageSize=${PAGE_SIZE}`,
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-3">
      <ResponsiveTable<OrgTicketRow>
        columns={COLUMNS}
        rows={data?.data ?? []}
        getRowId={(t) => t.id}
        isLoading={isLoading && !data}
        error={error}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={Inbox}
            title="No organization requests"
            description="Requests members raise about this organization appear here. The conversation stays between them and our team."
          />
        }
      />
      {data && data.total > PAGE_SIZE && (
        <TablePagination
          page={page}
          pageSize={PAGE_SIZE}
          total={data.total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
