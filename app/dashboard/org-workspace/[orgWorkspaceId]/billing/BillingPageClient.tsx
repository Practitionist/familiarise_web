"use client";

/**
 * Spend — the cross-org billing roll-up ("Spend" everywhere, #1527 §10). Distinct from per-org /billing under
 * /dashboard/organization/[orgId]/billing — that page shows ONE org's
 * invoices + wallet. This one rolls up the operator's whole portfolio
 * so cash-flow at a glance is one click away.
 *
 * Read-only in v1. Mutations (issue invoice, top up wallet, void) live
 * on the per-org page and only fire there — we don't want a
 * "destructive action across 5 orgs from one button" surface.
 *
 * Client half of the split page. The server `page.tsx` SSR-prefetches the
 * billing roll-up under ["org-workspace-billing", orgWorkspaceId]; the
 * useWorkspaceBilling hook below hydrates from that cache verbatim.
 */

import Link from "next/link";
import { Building2 } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { formatCurrencyAmount } from "@/utils/formatting";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyTotals } from "../currency-totals";
import {
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
} from "@/lib/labels/org-labels";
import {
  useWorkspaceBilling,
  type WorkspaceBillingPerOrgRow,
} from "../hooks/useWorkspaceBilling";

const columns: ResponsiveColumn<WorkspaceBillingPerOrgRow>[] = [
  {
    key: "org",
    header: "Organisation",
    primary: true,
    cell: (r) => (
      <Link
        href={`/dashboard/organization/${r.organizationId}/billing`}
        className="hover:underline"
      >
        <div className="font-medium">{r.organizationName}</div>
        <div className="text-xs text-muted-foreground">
          {r.organizationSlug}
          {r.organizationStatus !== "ACTIVE" && (
            <span className="ml-2">· {humanizeEnum(r.organizationStatus)}</span>
          )}
        </div>
      </Link>
    ),
  },
  {
    key: "funding",
    header: "Funding",
    cell: (r) =>
      r.fundingSource ? (
        <Badge
          variant="outline"
          className={FUNDING_SOURCE_BADGE_CLASS[r.fundingSource]}
        >
          {FUNDING_SOURCE_LABEL[r.fundingSource]}
        </Badge>
      ) : (
        <span className="text-xs text-muted-foreground">None</span>
      ),
  },
  {
    key: "wallet",
    header: "Wallet",
    className: "text-right tabular-nums",
    headClassName: "text-right",
    // Each org in its own currency (#1527).
    cell: (r) => formatCurrencyAmount(r.walletBalancePaise, r.currency),
  },
  {
    key: "outstanding",
    header: "Outstanding",
    className: "text-right tabular-nums",
    headClassName: "text-right",
    cell: (r) => (
      <div>
        <div>{formatCurrencyAmount(r.outstandingPaise, r.currency)}</div>
        {r.outstandingCount > 0 && (
          <div className="text-xs text-muted-foreground">
            {r.outstandingCount} open
          </div>
        )}
      </div>
    ),
  },
  {
    key: "members",
    header: "Members",
    className: "text-right tabular-nums",
    headClassName: "text-right",
    cell: (r) => r.activeMembers.toLocaleString("en-IN"),
  },
];

export function BillingPageClient({
  orgWorkspaceId,
}: {
  orgWorkspaceId: string;
}) {
  const { data, isLoading, isError, refetch } =
    useWorkspaceBilling(orgWorkspaceId);

  const summary = data?.summary;
  const rows = data?.perOrg ?? [];

  return (
    <>
      <DashboardHeader
        title="Spend"
        description="Outstanding invoices and wallet balances across the organizations you own."
      />
      <DashboardContent>
        {isError ? (
          <ErrorState
            title="Couldn't load the billing overview"
            description="We hit an error fetching your cross-org billing roll-up."
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <StatRow columns={3}>
              {isLoading || !summary ? (
                <>
                  <StatSkeleton />
                  <StatSkeleton />
                  <StatSkeleton />
                </>
              ) : (
                <>
                  <Stat
                    label="Outstanding"
                    hint={`across ${summary.orgsOwned} organization${summary.orgsOwned === 1 ? "" : "s"}`}
                    value={formatCurrencyTotals(summary.outstandingByCurrency)}
                    tone={
                      summary.outstandingByCurrency.length > 0
                        ? "warning"
                        : "neutral"
                    }
                  />
                  <Stat
                    label="Wallet balance"
                    hint="prepaid funds across orgs"
                    value={formatCurrencyTotals(summary.walletByCurrency)}
                  />
                  <Stat
                    label="Funded orgs"
                    hint="have a billing account"
                    value={rows
                      .filter((r) => r.fundingSource !== null)
                      .length.toString()}
                  />
                </>
              )}
            </StatRow>

            <section className="mt-6">
              <h2 className="text-lg font-medium mb-3">
                Per-organisation breakdown
              </h2>
              {isLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              ) : (
                <ResponsiveTable
                  columns={columns}
                  rows={rows}
                  getRowId={(r) => r.organizationId}
                  empty={
                    <EmptyState
                      icon={Building2}
                      title="No organisations to bill yet"
                      description="Create your first org from the Overview tab."
                    />
                  }
                />
              )}
            </section>
          </>
        )}
      </DashboardContent>
    </>
  );
}
