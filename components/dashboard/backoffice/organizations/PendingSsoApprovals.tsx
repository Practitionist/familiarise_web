"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Section } from "@/components/dashboard/Section";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type {
  PendingSsoApproval,
  PendingSsoPage,
} from "@/lib/backoffice/org-detail";
import { OperatorTime } from "@/lib/time/operator-time";

const columns: ResponsiveColumn<PendingSsoApproval>[] = [
  {
    key: "org",
    header: "Organization",
    primary: true,
    cell: (p) => (
      <div>
        <p className="font-medium">{p.orgName}</p>
        <p className="text-xs text-muted-foreground">{p.providerId}</p>
      </div>
    ),
  },
  { key: "domains", header: "Domains", cell: (p) => p.domains.join(", ") },
  { key: "issuer", header: "Issuer", cell: (p) => p.issuer },
  {
    key: "submitted",
    header: "Submitted",
    className: "text-sm text-muted-foreground",
    cell: (p) => <OperatorTime value={p.submittedAt} kind="date" />,
  },
];

/** The SSO approval queue, paged by `?ssoPage`; approve or revoke on the org's detail page. */
export function PendingSsoApprovals({
  pending,
  basePath,
}: Readonly<{ pending: PendingSsoPage; basePath: string }>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (pending.total === 0) return null;
  const toPage = (page: number) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("ssoPage", String(page));
    router.replace(`${pathname}?${next}`, { scroll: false });
  };
  return (
    <Section
      title="Pending SSO approvals"
      description="Providers organizations registered that cannot sign anyone in until approved."
      variant="card"
    >
      <ResponsiveTable<PendingSsoApproval>
        columns={columns}
        rows={pending.rows}
        getRowId={(p) => p.providerId}
        getRowHref={(p) => `${basePath}/organizations/${p.orgId}`}
      />
      <TablePagination
        className="pt-4"
        page={pending.page}
        pageSize={pending.pageSize}
        total={pending.total}
        onPageChange={toPage}
      />
    </Section>
  );
}
