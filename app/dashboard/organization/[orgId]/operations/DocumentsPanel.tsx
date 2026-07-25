"use client";

/**
 * Org-scoped documents dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 * Documents inherit org context via the parent Appointment.organizationId.
 */

import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface DocumentRow {
  id: string;
  fileName: string;
  reviewStatus: string;
  uploadedAt: string;
  uploadedByRole: string;
  appointment: {
    id: string;
    appointmentType: string;
    organizationId: string | null;
  };
}

interface DocumentsResponse {
  items: DocumentRow[];
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS: Column<DocumentRow>[] = [
  { header: "File", accessor: (r) => r.fileName },
  {
    header: "Review",
    accessor: (r) => <Badge variant="outline">{r.reviewStatus}</Badge>,
  },
  {
    header: "Type",
    accessor: (r) => r.appointment.appointmentType,
  },
  { header: "Uploaded by", accessor: (r) => r.uploadedByRole },
  {
    header: "Uploaded",
    accessor: (r) => format(new Date(r.uploadedAt), "PP"),
  },
];

export function DocumentsPanel({ orgId }: { orgId: string }) {
  // Page-level mirror of the API gate — previously this page had NO
  // guard and rendered an error shell for unauthorized roles (#audit F8).
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<DocumentsResponse>({
    enabled: allowed,
    queryKey: ["org-documents", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/documents?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <PanelHeader description="Documents attached to appointments under this organization. Useful for HR / compliance review." />
      <div className="space-y-6">
        <ScopedListTable
          title="Org documents"
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No documents uploaded under this organization yet."
        />
      </div>
    </>
  );
}
