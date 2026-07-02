"use client";

/**
 * Org-scoped documents dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 * Documents inherit org context via the parent Appointment.organizationId.
 */

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
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

export default function OrgDocumentsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<DocumentsResponse>({
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
      <DashboardHeader
        title="Documents"
        subtitle="Documents attached to appointments under this organization. Useful for HR / compliance review."
      />
      <DashboardContent>
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
      </DashboardContent>
    </>
  );
}
