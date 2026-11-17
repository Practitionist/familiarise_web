"use client";

/** Organization-owned correspondence, filtered by current operations/billing grants. */

import Link from "next/link";
import { useMemo } from "react";
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
import { caseKeyOf } from "@/lib/support/case-key";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { ISSUE_TYPE_LABELS } from "@/utils/supportTicketUrl";
import { supportKeys } from "@/lib/support/support-keys";
import { useZoneClock } from "@/lib/time/use-zone-clock";
import type { ZoneClock } from "@/lib/time/zone-clock";

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
  RESOLVED: "success",
  CLOSED: "neutral",
};

function buildColumns(
  orgId: string,
  clock: ZoneClock,
): ResponsiveColumn<OrgTicketRow>[] {
  return [
    {
      key: "subject",
      header: "Subject",
      primary: true,
      cell: (t) => (
        <Link
          href={`/dashboard/organization/${orgId}/support/requests/${caseKeyOf({ kind: "case", id: t.id })}`}
          className="group block min-w-0"
        >
          <span className="block truncate font-medium text-foreground group-hover:underline">
            {t.title}
          </span>
          {t.referenceNumber && (
            <span className="block font-mono text-[11px] text-muted-foreground">
              {t.referenceNumber}
            </span>
          )}
        </Link>
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
          {clock.date(t.createdAt)}
        </span>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (t) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {clock.date(t.updatedAt)}
        </span>
      ),
    },
  ];
}

export function OrgSupportRequests({ orgId }: Readonly<{ orgId: string }>) {
  const { page, setPage } = useListParams();
  const clock = useZoneClock();
  const columns = useMemo(() => buildColumns(orgId, clock), [orgId, clock]);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: supportKeys.orgRequests(orgId, page),
    queryFn: async (): Promise<OrgTicketsPage> => {
      const res = await fetch(
        `/api/organizations/${orgId}/support-tickets?page=${page}&pageSize=${PAGE_SIZE}`,
      );
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
    refetchOnMount: "always",
  });

  return (
    <div className="space-y-3">
      <ResponsiveTable<OrgTicketRow>
        columns={columns}
        rows={data?.data ?? []}
        getRowId={(t) => t.id}
        isLoading={isLoading && !data}
        error={error}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={Inbox}
            title="No organization support cases"
            description="Your organization’s operations and billing support cases appear here. Authorized teammates can follow the conversation with the platform team."
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
