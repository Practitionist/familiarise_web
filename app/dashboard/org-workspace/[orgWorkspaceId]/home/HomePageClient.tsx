"use client";

/**
 * "All organizations" home (#1527 §7.4) — the portfolio facet.
 *
 *   1. Figures — orgs you own, their active members, and what they owe and
 *      hold, one total per currency (never a mixed-currency sum).
 *   2. Every organization you belong to, grouped by your role in it, each
 *      with its status. Only OWNER rows used to show, so a maintainer or
 *      learner elsewhere had no way in from here.
 *   3. "New organization" — the create wizard inside this same chrome.
 *
 * The server page SSR-prefetches the org list and the billing roll-up under
 * the same query keys used below, so first paint needs no fetch.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { DataCardSkeleton } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  deriveCapabilityKind,
  CAPABILITY_LABEL,
  FUNDING_SOURCE_LABEL,
  MEMBER_ROLE_LABEL,
} from "@/lib/labels/org-labels";
import { ORG_STATUS } from "@/lib/labels/backoffice-labels";
import { useWorkspaceBilling } from "../hooks/useWorkspaceBilling";
import { formatCurrencyTotals } from "../currency-totals";

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

/** Group order: the roles that run an org first. */
const ROLE_ORDER: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "SUPPORT",
  "EXPERT",
  "LEARNER",
];

async function fetchOrgs(): Promise<{ data: OrgMembershipRow[] }> {
  const res = await fetch("/api/organizations");
  if (!res.ok) throw new Error("Failed to load organizations");
  return res.json();
}

function OrgCard({ row }: Readonly<{ row: OrgMembershipRow }>) {
  const org = row.organization;
  const kind = deriveCapabilityKind(org.canSponsor, org.canHost);
  const funding = org.billingAccount?.fundingSource ?? null;
  return (
    // The bare org route lands each role on its own page.
    <Link
      href={`/dashboard/organization/${org.id}`}
      className="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/30"
    >
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10 rounded-lg">
          <AvatarImage
            src={org.logo ?? undefined}
            alt={org.name}
            className="object-cover"
          />
          <AvatarFallback className="rounded-lg bg-muted text-muted-foreground">
            <Building2 className="h-5 w-5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate font-medium">{org.name}</p>
          <p className="truncate text-xs text-muted-foreground">{org.slug}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <StatusBadge {...ORG_STATUS[org.status]} size="sm" />
        <Badge variant="secondary">{CAPABILITY_LABEL[kind]}</Badge>
        {funding && (
          <Badge variant="outline">{FUNDING_SOURCE_LABEL[funding]}</Badge>
        )}
      </div>
    </Link>
  );
}

export function HomePageClient({ orgWorkspaceId }: { orgWorkspaceId: string }) {
  const orgs = useQuery({
    queryKey: ["org-workspace-orgs"],
    queryFn: fetchOrgs,
  });
  // Shared with the Spend page under one query key — see useWorkspaceBilling.
  const rollup = useWorkspaceBilling(orgWorkspaceId);
  const summary = rollup.data?.summary;
  const createHref = `/dashboard/org-workspace/${orgWorkspaceId}/create`;

  const rows = orgs.data?.data ?? [];
  const groups = ROLE_ORDER.map((role) => ({
    role,
    rows: rows.filter((r) => r.role === role),
  })).filter((g) => g.rows.length > 0);

  let figures: React.ReactNode;
  if (rollup.isError) {
    figures = (
      <ErrorState
        title="Couldn't load your totals"
        onRetry={() => void rollup.refetch()}
      />
    );
  } else if (rollup.isLoading || !summary) {
    figures = (
      <StatRow columns={4}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  } else {
    figures = (
      <StatRow columns={4}>
        <Stat label="Organizations you own" value={summary.orgsOwned} />
        <Stat
          label="Active members"
          value={summary.totalActiveMembers.toLocaleString("en-IN")}
        />
        <Stat
          label="Outstanding"
          value={formatCurrencyTotals(summary.outstandingByCurrency)}
          tone={
            summary.outstandingByCurrency.length > 0 ? "warning" : "neutral"
          }
        />
        <Stat
          label="Wallet balances"
          value={formatCurrencyTotals(summary.walletByCurrency)}
        />
      </StatRow>
    );
  }

  let list: React.ReactNode;
  if (orgs.isLoading) {
    list = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <DataCardSkeleton />
        <DataCardSkeleton />
        <DataCardSkeleton />
      </div>
    );
  } else if (orgs.isError) {
    list = (
      <ErrorState
        title="Couldn't load your organizations"
        onRetry={() => void orgs.refetch()}
      />
    );
  } else if (groups.length === 0) {
    list = (
      <EmptyState
        icon={Building2}
        title="No organizations yet"
        description="Create one to invite your team and start booking."
        action={
          <Button asChild size="sm">
            <Link href={createHref}>Create your first organization</Link>
          </Button>
        }
      />
    );
  } else {
    list = groups.map((g) => (
      <Section
        key={g.role}
        title={`${MEMBER_ROLE_LABEL[g.role]} (${g.rows.length})`}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {g.rows.map((row) => (
            <OrgCard key={row.membershipId} row={row} />
          ))}
        </div>
      </Section>
    ));
  }

  return (
    <>
      <DashboardHeader
        title="All organizations"
        description="Every organization you belong to, and what the ones you own owe and hold."
        actions={
          <Button asChild size="sm">
            <Link href={createHref}>
              <Plus className="mr-1 h-4 w-4" /> New organization
            </Link>
          </Button>
        }
      />
      <DashboardContent>
        {figures}
        {list}
      </DashboardContent>
    </>
  );
}
