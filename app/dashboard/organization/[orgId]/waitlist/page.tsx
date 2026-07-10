"use client";

/**
 * Org-scoped waitlist dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 */

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface WaitlistRow {
  id: string;
  joinedAt: string;
  status: string;
  position: number | null;
  user: { id: string; name: string | null; email: string };
  webinar: { id: string; webinarPlan: { title: string } } | null;
  class: { id: string; classPlan: { title: string } } | null;
}

interface WaitlistResponse {
  items: WaitlistRow[];
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS: Column<WaitlistRow>[] = [
  {
    header: "Member",
    accessor: (r) => r.user.name || r.user.email,
  },
  {
    header: "Event",
    accessor: (r) =>
      r.webinar?.webinarPlan?.title ?? r.class?.classPlan?.title ?? "—",
  },
  {
    header: "Status",
    accessor: (r) => <Badge variant="outline">{r.status}</Badge>,
  },
  {
    header: "Position",
    accessor: (r) => r.position ?? "—",
  },
  {
    header: "Joined",
    accessor: (r) => format(new Date(r.joinedAt), "PP"),
  },
];

export default function OrgWaitlistPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  // Page-level mirror of the API gate — previously this page had NO
  // guard and rendered an error shell for unauthorized roles (#audit F8).
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<WaitlistResponse>({
    enabled: allowed,
    queryKey: ["org-waitlist", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/waitlist?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <DashboardHeader
        title="Waitlist"
        subtitle="Members queued for full webinars / classes under this organization."
      />
      <DashboardContent>
        <ScopedListTable
          title="Org waitlist"
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No waitlist entries under this organization."
        />
      </DashboardContent>
    </>
  );
}
