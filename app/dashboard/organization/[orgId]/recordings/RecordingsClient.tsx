"use client";

/**
 * Org-scoped recordings dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 * Recordings carry a denormalized `organizationId` (synced at checkout
 * + via the backfill script).
 */

import { useQuery } from "@tanstack/react-query";
import type { RecordingStatus } from "@prisma/client";
import { useRequireOrgAccess } from "../useOrgRole";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { recordingStatusBadge } from "@/lib/labels/session-labels";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface RecordingRow {
  id: string;
  title: string;
  status: RecordingStatus;
  recordedAt: string;
  durationInMinutes: number;
}

interface RecordingsResponse {
  items: RecordingRow[];
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS: Column<RecordingRow>[] = [
  { header: "Title", accessor: (r) => r.title },
  {
    header: "Status",
    // #1762-4 — the shared recording label map, not the raw enum.
    accessor: (r) => <StatusBadge {...recordingStatusBadge(r.status)} />,
  },
  {
    header: "Duration",
    accessor: (r) => `${r.durationInMinutes} min`,
  },
  {
    header: "Recorded",
    accessor: (r) => format(new Date(r.recordedAt), "PP"),
  },
];

export function RecordingsClient({ orgId }: { orgId: string }) {
  // Page-level mirror of the API gate — previously this page had NO
  // guard and rendered an error shell for unauthorized roles (#audit F8).
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<RecordingsResponse>({
    enabled: allowed,
    queryKey: ["org-recordings", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/recordings?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <DashboardHeader
        title="Recordings"
        description="Session recordings for events run under this organization."
      />
      <DashboardContent>
        <ScopedListTable
          title="Org recordings"
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No recordings under this organization yet."
        />
      </DashboardContent>
    </>
  );
}
