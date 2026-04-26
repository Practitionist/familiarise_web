"use client";

/**
 * Operator dashboard home — the canonical place to land after creating
 * an organisation. Replaces the prior 1-org-auto-redirect chooser stub
 * AND the old /dashboard/organization switcher list.
 *
 * What you see:
 *   1. Stats row — orgs you own, active members across them, outstanding
 *      INR across all your billing accounts.
 *   2. Org grid — every org you operate, capability + funding + role
 *      badges, click to enter that org's dashboard.
 *   3. "+ New organization" CTA — opens the create wizard inside this
 *      same dashboard chrome at /create.
 *
 * Design intent: this is a *cross-org* surface. Per-org operator views
 * (members, programs, billing) live one click deeper at
 * /dashboard/organization/[orgId]/*. The two layers don't overlap.
 */

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, Users, Wallet } from "lucide-react";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  CAPABILITY_BADGE_CLASS,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_BADGE_CLASS,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";

interface OrgMembershipRow {
  membershipId: string;
  role: MemberRole;
  status: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    billingAccount: {
      fundingSource: FundingSource;
      walletBalance: number | null;
      currency: string;
    } | null;
  };
}

async function fetchOrgs(): Promise<{ data: OrgMembershipRow[] }> {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

interface BillingRollup {
  orgsOwned: number;
  totalActiveMembers: number;
  totalOutstandingPaise: number;
  totalWalletPaise: number;
}

async function fetchRollup(orgAdminId: string): Promise<BillingRollup> {
  const res = await fetch(`/api/org-admin/${orgAdminId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing roll-up");
  const json = (await res.json()) as { summary: BillingRollup };
  return json.summary;
}

export default function OrgAdminHomePage({
  params,
}: {
  params: Promise<{ orgAdminId: string }>;
}) {
  const { orgAdminId } = use(params);

  const orgs = useQuery({
    queryKey: ["org-admin-orgs"],
    queryFn: fetchOrgs,
  });
  const rollup = useQuery({
    queryKey: ["org-admin-rollup", orgAdminId],
    queryFn: () => fetchRollup(orgAdminId),
  });

  const rows = (orgs.data?.data ?? []).filter((r) => r.role === "OWNER");

  return (
    <>
      <DashboardHeader
        title="Operator dashboard"
        subtitle="Cross-org snapshot of the organisations you run"
        actions={
          <Link href={`/dashboard/org-admin/${orgAdminId}/create`}>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New organization
            </Button>
          </Link>
        }
      />
      <DashboardContent>
        <DashboardGrid>
          {rollup.isLoading ? (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          ) : (
            <>
              <StatCard
                title="Organisations"
                value={rollup.data?.orgsOwned.toString() ?? "0"}
                icon={Building2}
              />
              <StatCard
                title="Active members"
                value={
                  rollup.data?.totalActiveMembers.toLocaleString("en-IN") ?? "0"
                }
                icon={Users}
              />
              <StatCard
                title="Outstanding (INR)"
                value={formatCurrencyAmount(
                  rollup.data?.totalOutstandingPaise ?? 0,
                  "INR",
                )}
                icon={Wallet}
                variant={
                  rollup.data && rollup.data.totalOutstandingPaise > 0
                    ? "warning"
                    : "default"
                }
              />
            </>
          )}
        </DashboardGrid>

        <section className="mt-6">
          <h2 className="text-lg font-medium mb-3">Your organisations</h2>
          {orgs.isLoading ? (
            <p className="text-sm text-zinc-500">Loading organizations…</p>
          ) : rows.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rows.map((row) => {
                const org = row.organization;
                const kind = deriveCapabilityKind(org.canSponsor, org.canHost);
                const funding = org.billingAccount?.fundingSource ?? null;
                return (
                  <Link
                    key={row.membershipId}
                    href={`/dashboard/organization/${org.id}/home`}
                    className="group"
                  >
                    <Card className="h-full hover:border-zinc-400 transition-colors">
                      <CardHeader>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center overflow-hidden">
                            {org.logo ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={org.logo}
                                alt={org.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Building2 className="w-5 h-5 text-zinc-500" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="truncate text-base">
                              {org.name}
                            </CardTitle>
                            <CardDescription className="text-xs">
                              {org.slug}
                            </CardDescription>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2">
                        <Badge
                          variant="secondary"
                          className={CAPABILITY_BADGE_CLASS[kind]}
                        >
                          {CAPABILITY_LABEL[kind]}
                        </Badge>
                        {funding && (
                          <Badge
                            variant="outline"
                            className={FUNDING_SOURCE_BADGE_CLASS[funding]}
                          >
                            {FUNDING_SOURCE_LABEL[funding]}
                          </Badge>
                        )}
                        <Badge>{MEMBER_ROLE_LABEL[row.role]}</Badge>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Building2 className="w-10 h-10 mx-auto mb-3 text-zinc-400" />
                <p className="text-sm text-zinc-600">
                  You don&apos;t own any organisations yet.
                </p>
                <Link href={`/dashboard/org-admin/${orgAdminId}/create`}>
                  <Button size="sm" className="mt-4">
                    Create your first organisation
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}
        </section>
      </DashboardContent>
    </>
  );
}
