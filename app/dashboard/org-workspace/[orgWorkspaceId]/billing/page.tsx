"use client";

/**
 * Cross-org billing roll-up. Distinct from per-org /billing under
 * /dashboard/organization/[orgId]/billing — that page shows ONE org's
 * invoices + wallet. This one rolls up the operator's whole portfolio
 * so cash-flow at a glance is one click away.
 *
 * Read-only in v1. Mutations (issue invoice, top up wallet, void) live
 * on the per-org page and only fire there — we don't want a
 * "destructive action across 5 orgs from one button" surface.
 */

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Wallet, Receipt, Building2 } from "lucide-react";
import type { FundingSource } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
} from "@/lib/labels/org-labels";

interface PerOrgRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationStatus: string;
  fundingSource: FundingSource | null;
  currency: string;
  walletBalancePaise: number;
  outstandingCount: number;
  outstandingPaise: number;
  activeMembers: number;
}

interface RollupResponse {
  summary: {
    orgsOwned: number;
    totalActiveMembers: number;
    totalOutstandingPaise: number;
    totalWalletPaise: number;
  };
  perOrg: PerOrgRow[];
}

async function fetchRollup(orgWorkspaceId: string): Promise<RollupResponse> {
  const res = await fetch(`/api/org-workspace/${orgWorkspaceId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing roll-up");
  return res.json();
}

export default function OrgWorkspaceBillingPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = use(params);

  const { data, isLoading } = useQuery({
    queryKey: ["org-workspace-billing", orgWorkspaceId],
    queryFn: () => fetchRollup(orgWorkspaceId),
  });

  const summary = data?.summary;
  const rows = data?.perOrg ?? [];

  return (
    <>
      <DashboardHeader
        title="Billing overview"
        subtitle="Outstanding invoices and wallet balances across the organisations you operate"
      />
      <DashboardContent>
        <DashboardGrid>
          {isLoading || !summary ? (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          ) : (
            <>
              <StatCard
                title="Outstanding"
                subtitle={`across ${summary.orgsOwned} organisation${summary.orgsOwned === 1 ? "" : "s"}`}
                value={formatCurrencyAmount(
                  summary.totalOutstandingPaise,
                  "INR",
                )}
                icon={Receipt}
                variant={
                  summary.totalOutstandingPaise > 0 ? "warning" : "default"
                }
              />
              <StatCard
                title="Wallet balance"
                subtitle="prepaid funds across orgs"
                value={formatCurrencyAmount(summary.totalWalletPaise, "INR")}
                icon={Wallet}
              />
              <StatCard
                title="Funded orgs"
                subtitle="have a billing account"
                value={rows
                  .filter((r) => r.fundingSource !== null)
                  .length.toString()}
                icon={CreditCard}
              />
            </>
          )}
        </DashboardGrid>

        <section className="mt-6">
          <h2 className="text-lg font-medium mb-3">Per-organisation breakdown</h2>
          {isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : rows.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <Building2 className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
                <p className="text-sm text-zinc-600">
                  No organisations to bill yet. Create your first org from the
                  Overview tab.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Organisation</th>
                    <th className="px-4 py-2 font-medium">Funding</th>
                    <th className="px-4 py-2 font-medium text-right">Wallet</th>
                    <th className="px-4 py-2 font-medium text-right">
                      Outstanding
                    </th>
                    <th className="px-4 py-2 font-medium text-right">Members</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.organizationId} className="border-t">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/organization/${r.organizationId}/billing`}
                          className="hover:underline"
                        >
                          <div className="font-medium">{r.organizationName}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.organizationSlug}
                            {r.organizationStatus !== "ACTIVE" && (
                              <span className="ml-2 text-amber-600">
                                · {r.organizationStatus.toLowerCase()}
                              </span>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {r.fundingSource ? (
                          <Badge
                            variant="outline"
                            className={
                              FUNDING_SOURCE_BADGE_CLASS[r.fundingSource]
                            }
                          >
                            {FUNDING_SOURCE_LABEL[r.fundingSource]}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            None
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatCurrencyAmount(r.walletBalancePaise, "INR")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div>
                          {formatCurrencyAmount(r.outstandingPaise, "INR")}
                        </div>
                        {r.outstandingCount > 0 && (
                          <div className="text-xs text-muted-foreground">
                            {r.outstandingCount} open
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {r.activeMembers.toLocaleString("en-IN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </DashboardContent>
    </>
  );
}
