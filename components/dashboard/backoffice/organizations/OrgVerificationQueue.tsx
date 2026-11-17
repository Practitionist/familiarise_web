"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import {
  organizationListPageSchema,
  type OrganizationListItem as QueuedOrg,
} from "@/lib/backoffice/people-list-schemas";
import { OperatorTime } from "@/lib/time/operator-time";
import { OrgLifecycleActions } from "./OrgLifecycleActions";

const PAGE_SIZE = 25;

const columns: ResponsiveColumn<QueuedOrg>[] = [
  {
    key: "name",
    header: "Organization",
    primary: true,
    cell: (o) => (
      <div>
        <p className="font-medium">{o.name}</p>
        <p className="text-xs text-muted-foreground">{o.billingEmail}</p>
      </div>
    ),
  },
  { key: "members", header: "Members", cell: (o) => `${o._count.memberships}` },
  {
    key: "created",
    header: "Created",
    className: "text-sm text-muted-foreground",
    cell: (o) => <OperatorTime value={o.createdAt} kind="date" />,
  },
];

/**
 * #1527 — organizations waiting on verification (the Verification page's
 * Organizations tab and its nav badge share `queue=verification`). Verify
 * and Reject run here; the detail page has the KYB and GST facts.
 */
export function OrgVerificationQueue() {
  const { basePath } = useBackofficeCapability();
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-organizations", "verification-queue", page],
    queryFn: async () => {
      const params = new URLSearchParams({
        queue: "verification",
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/organizations?${params}`);
      return readListBody(
        res,
        organizationListPageSchema,
        "Organizations could not load.",
      );
    },
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <ResponsiveTable<QueuedOrg>
        columns={columns}
        rows={data?.data ?? []}
        getRowId={(o) => o.id}
        getRowHref={(o) => `${basePath}/organizations/${o.id}`}
        rowActions={(o) => <OrgLifecycleActions org={o} />}
        isLoading={isLoading && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            No organization is waiting on verification.
          </p>
        }
      />
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data?.pagination.total ?? 0}
        onPageChange={setPage}
      />
    </div>
  );
}
