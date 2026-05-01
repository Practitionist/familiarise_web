"use client";

/**
 * C4: Reimbursement-report dashboard for orgs on PERSONAL funding.
 * MANAGER+ at the org. Shows per-member totals and a paginated
 * payment list. CSV export downloads via /export endpoint.
 */

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import {
  ScopedListTable,
  type Column,
} from "@/components/enterprise/ScopedListTable";

interface ReimbursementRow {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
}

interface ByMemberRow {
  userId: string;
  name: string | null;
  email: string | null;
  totalPaise: number;
  paymentCount: number;
}

interface ReimbursementsResponse {
  items: ReimbursementRow[];
  total: number;
  page: number;
  perPage: number;
  totalPaise: number;
  byMember: ByMemberRow[];
}

const COLUMNS: Column<ReimbursementRow>[] = [
  {
    header: "Date",
    accessor: (r) => format(new Date(r.createdAt), "PP"),
  },
  {
    header: "Member",
    accessor: (r) => r.user.name || r.user.email,
  },
  { header: "Description", accessor: (r) => r.description ?? "—" },
  {
    header: "Amount",
    accessor: (r) => `${(r.amount / 100).toFixed(2)} ${r.currency}`,
  },
  {
    header: "Payment",
    accessor: (r) => (
      <Badge variant="outline" className="font-mono text-xs">
        {r.id.slice(0, 8)}
      </Badge>
    ),
  },
];

export default function OrgReimbursementsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError, error } =
    useQuery<ReimbursementsResponse>({
      queryKey: ["org-reimbursements", orgId, page],
      queryFn: async () => {
        const res = await fetch(
          `/api/organizations/${orgId}/reimbursements?page=${page}`,
        );
        if (res.status === 404) {
          throw new Error(
            "This org is not on PERSONAL funding — reimbursements view is unavailable.",
          );
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });

  const totalRupees = ((data?.totalPaise ?? 0) / 100).toFixed(2);

  return (
    <>
      <DashboardHeader
        title="Reimbursements"
        subtitle="Members paid out of pocket on org bookings — pay them back via your payroll using this report."
        actions={
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/organizations/${orgId}/reimbursements/export`}
              download
            >
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </a>
          </Button>
        }
      />
      <DashboardContent>
        {data && (
          <div className="mb-4 flex flex-wrap gap-3">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Total to reimburse
              </p>
              <p className="mt-1 text-2xl font-semibold">₹{totalRupees}</p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Members owed
              </p>
              <p className="mt-1 text-2xl font-semibold">
                {data.byMember.length}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Payments
              </p>
              <p className="mt-1 text-2xl font-semibold">{data.total}</p>
            </div>
          </div>
        )}

        <ScopedListTable
          title="Reimbursable payments"
          isLoading={isLoading}
          isError={isError}
          errorMessage={
            error instanceof Error ? error.message : "Failed to load."
          }
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No reimbursable payments yet — members on this org haven't paid out of pocket for any sessions."
        />
      </DashboardContent>
    </>
  );
}
