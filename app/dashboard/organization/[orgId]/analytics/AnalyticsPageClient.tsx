"use client";

import { useQuery } from "@tanstack/react-query";
import type { FundingSource, MemberRole } from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { ErrorState } from "@/components/dashboard/ErrorState";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { MEMBER_ROLE_LABEL } from "@/lib/labels/org-labels";
import { humanizeEnum } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";

// Types — match GET /api/organizations/[orgId]/analytics. Money sections are
// null for viewers without `billing.read` (#1527, redacted server-side).
interface OrgAnalytics {
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    currency: string | null;
  };
  members: {
    total: number;
    active: number;
    byRole: Array<{ role: MemberRole; count: number }>;
  };
  programs: {
    total: number;
    active: number;
    activeAssignments: number;
  };
  wallet: {
    balancePaise: number;
    recent: Array<{ reason: string; count: number; deltaPaise: number }>;
  } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
    paidLast30dCount: number;
    paidLast30dPaise: number;
  } | null;
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

type RoleRow = { role: MemberRole; count: number };
type WalletRow = NonNullable<OrgAnalytics["wallet"]>["recent"][number];

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

const roleColumns: ResponsiveColumn<RoleRow>[] = [
  {
    key: "role",
    header: "Role",
    primary: true,
    cell: (r) => MEMBER_ROLE_LABEL[r.role],
  },
  {
    key: "count",
    header: "Active members",
    className: "tabular-nums",
    cell: (r) => r.count,
  },
];

function walletColumns(currency: string): ResponsiveColumn<WalletRow>[] {
  return [
    {
      key: "reason",
      header: "Movement",
      primary: true,
      cell: (r) => humanizeEnum(r.reason),
    },
    {
      key: "count",
      header: "Entries",
      className: "tabular-nums",
      cell: (r) => r.count,
    },
    {
      key: "delta",
      header: "Net",
      className: "tabular-nums",
      cell: (r) => formatCurrencyAmount(r.deltaPaise, currency),
    },
  ];
}

function MoneyStats({ data }: Readonly<{ data: OrgAnalytics }>) {
  const currency = data.capabilities.currency ?? "INR";
  const paidEarnings =
    data.earnings?.find((e) => e.status === "PAID")?.orgSharePaise ?? 0;
  const refundedEarnings = (data.earnings ?? []).reduce(
    (sum, e) => sum + e.refundedPaise,
    0,
  );
  const hasEarnings = (data.earnings?.length ?? 0) > 0;
  if (!data.wallet && !data.invoices && !hasEarnings) return null;
  return (
    <StatRow columns={3}>
      {data.wallet && (
        <Stat
          label="Wallet balance"
          value={formatCurrencyAmount(data.wallet.balancePaise, currency)}
        />
      )}
      {data.invoices && (
        <>
          <Stat
            label="Outstanding invoices"
            value={data.invoices.outstandingCount}
            hint={formatCurrencyAmount(
              data.invoices.outstandingPaise,
              currency,
            )}
            tone={data.invoices.pastDueCount > 0 ? "critical" : "neutral"}
          />
          <Stat
            label="Paid in the last 30 days"
            value={data.invoices.paidLast30dCount}
            hint={formatCurrencyAmount(
              data.invoices.paidLast30dPaise,
              currency,
            )}
          />
        </>
      )}
      {hasEarnings && (
        <Stat
          label="Earnings paid out"
          value={formatCurrencyAmount(paidEarnings, currency)}
          hint={
            refundedEarnings > 0
              ? `${formatCurrencyAmount(refundedEarnings, currency)} refunded`
              : undefined
          }
        />
      )}
    </StatRow>
  );
}

/**
 * Org Analytics: membership and program figures for operators, with money
 * only for `billing.read` (#1527 — SUPPORT used to see it). Home carries the
 * action centre now, so this page no longer mirrors it; charts are #663.
 */
export function AnalyticsPageClient({ orgId }: { orgId: string }) {
  const { can } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
    enabled: allowed,
  });

  if (!allowed) return null;

  const header = (
    <DashboardHeader
      title="Analytics"
      description="Membership, programs and, for finance roles, money at a glance."
    />
  );

  if (isError && !data) {
    return (
      <>
        {header}
        <DashboardContent>
          <ErrorState
            title="Couldn't load analytics"
            onRetry={() => void refetch()}
          />
        </DashboardContent>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        {header}
        <DashboardContent>
          <StatRow columns={3}>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </StatRow>
        </DashboardContent>
      </>
    );
  }

  const seesMoney = can("billing.read");
  const currency = data.capabilities.currency ?? "INR";

  return (
    <>
      {header}
      <DashboardContent>
        <StatRow columns={3}>
          <Stat
            label="Members"
            value={data.members.total}
            hint={`${data.members.active} active`}
          />
          <Stat
            label="Active programs"
            value={data.programs.active}
            hint={`${data.programs.total} total`}
          />
          <Stat
            label="Active assignments"
            value={data.programs.activeAssignments}
          />
        </StatRow>
        {seesMoney && <MoneyStats data={data} />}
        <Section title="Members by role">
          <ResponsiveTable<RoleRow>
            columns={roleColumns}
            rows={data.members.byRole}
            getRowId={(r) => r.role}
            empty="No active members yet."
          />
        </Section>
        {seesMoney && data.wallet && data.wallet.recent.length > 0 && (
          <Section title="Wallet activity, last 30 days">
            <ResponsiveTable<WalletRow>
              columns={walletColumns(currency)}
              rows={data.wallet.recent}
              getRowId={(r) => r.reason}
            />
          </Section>
        )}
      </DashboardContent>
    </>
  );
}
