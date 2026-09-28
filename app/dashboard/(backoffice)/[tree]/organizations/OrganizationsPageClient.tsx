"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { ORG_STATUS, orgStatus } from "@/lib/labels/backoffice-labels";
import { humanizeEnum } from "@/lib/ui/tone";

export interface OrgListItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  canSponsor: boolean;
  canHost: boolean;
  billingEmail: string;
  createdAt: string;
  billingAccount: { id: string; fundingSource: string } | null;
  _count: { memberships: number; contracts: number };
}

const PAGE_SIZE = 25; // the route's default page size

const STATUS_OPTIONS = Object.entries(ORG_STATUS).map(([value, t]) => ({
  value,
  label: t.label,
}));

function capabilityLabel(o: OrgListItem): string {
  if (o.canSponsor && o.canHost) return "Sponsor and host";
  if (o.canSponsor) return "Sponsor";
  if (o.canHost) return "Host";
  return "Neither yet";
}

const columns: ResponsiveColumn<OrgListItem>[] = [
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
  {
    key: "status",
    header: "Status",
    cell: (o) => <StatusBadge {...orgStatus(o.status)} />,
  },
  { key: "kind", header: "Can", cell: capabilityLabel },
  {
    key: "funding",
    header: "Funding",
    cell: (o) =>
      o.billingAccount
        ? humanizeEnum(o.billingAccount.fundingSource)
        : "No billing account",
  },
  {
    key: "members",
    header: "Members",
    cell: (o) => `${o._count.memberships}`,
  },
  {
    key: "created",
    header: "Created",
    className: "text-sm text-muted-foreground",
    cell: (o) => new Date(o.createdAt).toLocaleDateString(),
  },
];

/**
 * #1527 — the organization list; lifecycle actions and the invoice composer
 * live on each org's detail page, and pending ones also queue on
 * Verification.
 */
export default function OrganizationsPageClient() {
  const { basePath } = useBackofficeCapability();
  const [status, setStatus] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-organizations", status, search, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      const res = await fetch(`/api/admin/organizations?${params}`);
      if (!res.ok) throw new Error("Failed to load organizations");
      return (await res.json()) as {
        data: OrgListItem[];
        pagination: { total: number };
      };
    },
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="Every organization on the platform. Open one to verify, suspend or invoice it."
      />
      <ResponsiveTable<OrgListItem>
        columns={columns}
        rows={data?.data ?? []}
        getRowId={(o) => o.id}
        getRowHref={(o) => `${basePath}/organizations/${o.id}`}
        isLoading={isLoading && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        toolbar={
          <FilterBar
            search={{
              label: "Search organizations",
              placeholder: "Name, slug or billing email",
              value: search,
              onChange: (v) => {
                setSearch(v);
                setPage(1);
              },
            }}
            chips={{
              label: "Status",
              options: STATUS_OPTIONS,
              value: status,
              onChange: (v) => {
                setStatus(v);
                setPage(1);
              },
              clearable: true,
            }}
          />
        }
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            No organizations match these filters.
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
