"use client";

import { Section } from "@/components/dashboard/Section";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type { PendingSsoApproval } from "@/lib/backoffice/org-detail";

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
    cell: (p) => new Date(p.submittedAt).toLocaleDateString(),
  },
];

/** The SSO approval queue; approve or revoke on the org's detail page. */
export function PendingSsoApprovals({
  rows,
  basePath,
}: Readonly<{ rows: PendingSsoApproval[]; basePath: string }>) {
  if (rows.length === 0) return null;
  return (
    <Section
      title="Pending SSO approvals"
      description="Providers organizations registered that cannot sign anyone in until approved."
      variant="card"
    >
      <ResponsiveTable<PendingSsoApproval>
        columns={columns}
        rows={rows}
        getRowId={(p) => p.providerId}
        getRowHref={(p) => `${basePath}/organizations/${p.orgId}`}
      />
    </Section>
  );
}
