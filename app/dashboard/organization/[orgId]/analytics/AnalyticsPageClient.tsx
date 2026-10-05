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

interface MonthlySeriesPoint {
  month: string;
  spendPaise: number;
  engagementsCount: number;
  overagePaise: number;
  activeLearners: number;
}

interface ProgramBreakdownRow {
  programId: string;
  name: string;
  subType: string;
  utilizedPaise: number;
  engagementsUsed: number;
  overageCount: number;
}

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
  monthlySeries?: MonthlySeriesPoint[];
  programBreakdown?: ProgramBreakdownRow[];
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

const MONTH_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return MONTH_FORMATTER.format(new Date(Date.UTC(y, m - 1, 1)));
}

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

function programBreakdownColumns(
  currency: string,
  seesMoney: boolean,
): ResponsiveColumn<ProgramBreakdownRow>[] {
  const cols: ResponsiveColumn<ProgramBreakdownRow>[] = [
    {
      key: "name",
      header: "Program",
      primary: true,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "subType",
      header: "Model",
      cell: (r) => (
        <span className="text-muted-foreground">
          {r.subType === "CREDIT_POOL" ? "Credit Pool" : "Licensed Seat"}
        </span>
      ),
    },
    {
      key: "engagementsUsed",
      header: "Engagements used",
      className: "tabular-nums",
      cell: (r) => r.engagementsUsed.toLocaleString("en-IN"),
    },
    {
      key: "overageCount",
      header: "Overages",
      className: "tabular-nums",
      cell: (r) => r.overageCount.toLocaleString("en-IN"),
    },
  ];

  if (seesMoney) {
    cols.push({
      key: "utilizedPaise",
      header: "Utilized spend",
      className: "tabular-nums",
      cell: (r) => formatCurrencyAmount(r.utilizedPaise, currency),
    });
  }

  return cols;
}

function MonthlyTrendChart({
  series,
  currency,
  seesMoney,
}: Readonly<{
  series: MonthlySeriesPoint[];
  currency: string;
  seesMoney: boolean;
}>) {
  if (series.length === 0) return null;

  const maxSpend = Math.max(1, ...series.map((s) => s.spendPaise));
  const maxEngagements = Math.max(1, ...series.map((s) => s.engagementsCount));

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        {series.map((pt) => {
          const primaryRatio = seesMoney
            ? Math.round((pt.spendPaise / maxSpend) * 100)
            : Math.round((pt.engagementsCount / maxEngagements) * 100);
          const barHeightPct = Math.max(
            pt.spendPaise > 0 || pt.engagementsCount > 0 ? 8 : 2,
            primaryRatio,
          );
          return (
            <div
              key={pt.month}
              className="flex flex-col justify-between rounded-md border bg-muted/20 p-3"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {formatMonthLabel(pt.month)}
                </span>
                <span>{pt.activeLearners} active</span>
              </div>

              <div className="my-3 flex h-24 items-end gap-1.5 rounded bg-muted/40 p-2">
                <div
                  className="w-full rounded-t bg-primary/80 transition-all"
                  style={{ height: `${barHeightPct}%` }}
                  title={
                    seesMoney
                      ? `${formatCurrencyAmount(pt.spendPaise, currency)} (${pt.engagementsCount} engagements)`
                      : `${pt.engagementsCount} engagements`
                  }
                />
              </div>

              <div className="space-y-0.5 text-xs">
                {seesMoney && (
                  <p className="font-semibold tabular-nums">
                    {formatCurrencyAmount(pt.spendPaise, currency)}
                  </p>
                )}
                <p className="text-muted-foreground tabular-nums">
                  {pt.engagementsCount}{" "}
                  {pt.engagementsCount === 1 ? "engagement" : "engagements"}
                </p>
                {seesMoney && pt.overagePaise > 0 && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400 tabular-nums">
                    +{formatCurrencyAmount(pt.overagePaise, currency)} overage
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
 * Org Analytics: membership, 6-month utilization trends, and per-program
 * breakdown for operators, with money only for `billing.read`.
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
  const monthlySeries = data.monthlySeries ?? [];
  const programBreakdown = data.programBreakdown ?? [];

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
        {monthlySeries.length > 0 && (
          <Section
            title={
              seesMoney
                ? "Monthly spend & utilization (last 6 months)"
                : "Monthly utilization (last 6 months)"
            }
          >
            <MonthlyTrendChart
              series={monthlySeries}
              currency={currency}
              seesMoney={seesMoney}
            />
          </Section>
        )}
        <Section title="Program utilization breakdown">
          <ResponsiveTable<ProgramBreakdownRow>
            columns={programBreakdownColumns(currency, seesMoney)}
            rows={programBreakdown}
            getRowId={(r) => r.programId}
            empty="No programs configured yet."
          />
        </Section>
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
