"use client";

/**
 * Org-scoped trials dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 * `TrialSession.organizationId` already exists (predates #674) so this
 * just lists rows already tagged to the org.
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
} from "@/components/enterprise/ScopedListTable";

interface TrialRow {
  id: string;
  status: string;
  requestedAt: string;
  consulteeProfile: {
    user: { id: string; name: string | null; email: string };
  };
  consultantProfile: {
    user: { id: string; name: string | null; email: string };
  };
  subscriptionPlan: { title: string };
}

interface TrialsResponse {
  items: TrialRow[];
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS: Column<TrialRow>[] = [
  {
    header: "Member",
    accessor: (r) =>
      r.consulteeProfile.user.name || r.consulteeProfile.user.email,
  },
  {
    header: "Consultant",
    accessor: (r) =>
      r.consultantProfile.user.name || r.consultantProfile.user.email,
  },
  { header: "Plan", accessor: (r) => r.subscriptionPlan.title },
  {
    header: "Status",
    accessor: (r) => <Badge variant="outline">{r.status}</Badge>,
  },
  {
    header: "Requested",
    accessor: (r) => format(new Date(r.requestedAt), "PP"),
  },
];

export default function OrgTrialsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<TrialsResponse>({
    queryKey: ["org-trials", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/trials?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <DashboardHeader
        title="Trials"
        subtitle="Free trial sessions taken by this organization's members. Useful for sales pipeline reporting."
      />
      <DashboardContent>
        <ScopedListTable
          title="Org trial sessions"
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No trials under this organization yet."
        />
      </DashboardContent>
    </>
  );
}
