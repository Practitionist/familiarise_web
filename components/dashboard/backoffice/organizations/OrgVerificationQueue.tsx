"use client";

import { useQuery } from "@tanstack/react-query";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { OrgLifecycleActions } from "./OrgLifecycleActions";

interface QueuedOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
  billingEmail: string | null;
  createdAt: string;
  _count: { memberships: number };
}

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
    cell: (o) => new Date(o.createdAt).toLocaleDateString(),
  },
];

/**
 * #1527 — organizations waiting on verification (the Verification page's
 * Organizations tab and its nav badge share `queue=verification`). Verify
 * and Reject run here; the detail page has the KYB and GST facts.
 */
export function OrgVerificationQueue() {
  const { basePath } = useBackofficeCapability();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-organizations", "verification-queue"],
    queryFn: async () => {
      const res = await fetch(
        "/api/admin/organizations?queue=verification&limit=100",
      );
      if (!res.ok) throw new Error("Failed to load organizations");
      return (await res.json()) as { data: QueuedOrg[] };
    },
  });

  return (
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
  );
}
