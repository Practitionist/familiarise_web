"use client";

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import type { FundingSource, MemberRole } from "@prisma/client";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Button } from "@/components/ui/button";
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
  overagePaise?: number;
}

interface FeedbackConsultantRow {
  consultantProfileId: string;
  name: string | null;
  average: number | null;
  responses: number | null;
  respondents: number | null;
}

interface OrgFeedbackSummary {
  data: {
    averageRating: number | null;
    totalResponses: number | null;
    respondents: number | null;
    averageRating30d: number | null;
    responses30d: number | null;
    respondents30d: number | null;
    minRespondents: number;
    byConsultant: FeedbackConsultantRow[];
    consultantsSuppressed: number;
  };
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

async function fetchFeedbackSummary(
  orgId: string,
): Promise<OrgFeedbackSummary> {
  const res = await fetch(`/api/organizations/${orgId}/feedback-summary`);
  if (!res.ok) throw new Error("Failed to load feedback summary");
  return res.json();
}

function escapeCsvCell(value: string): string {
  const isNumeric = /^[+-]?\d+(\.\d+)?$/.test(value.trim());
  const neutralized =
    !isNumeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function downloadUtilizationCsv(
  orgId: string,
  monthlySeries: MonthlySeriesPoint[],
  programBreakdown: ProgramBreakdownRow[],
  seesMoney: boolean,
) {
  const lines: string[] = [
    seesMoney
      ? "Section,NameOrMonth,Model,Engagements,OveragesOrActiveLearners,SpendINR,OverageINR"
      : "Section,NameOrMonth,Model,Engagements,OveragesOrActiveLearners",
  ];
  for (const pt of monthlySeries) {
    const safeMonth = escapeCsvCell(pt.month);
    lines.push(
      seesMoney
        ? `Monthly,${safeMonth},,${pt.engagementsCount},${pt.activeLearners},${(pt.spendPaise / 100).toFixed(2)},${(pt.overagePaise / 100).toFixed(2)}`
        : `Monthly,${safeMonth},,${pt.engagementsCount},${pt.activeLearners}`,
    );
  }
  for (const row of programBreakdown) {
    const safeName = escapeCsvCell(row.name);
    const safeSubType = escapeCsvCell(row.subType);
    const overageInr = ((row.overagePaise ?? 0) / 100).toFixed(2);
    lines.push(
      seesMoney
        ? `Program,${safeName},${safeSubType},${row.engagementsUsed},${row.overageCount},${(row.utilizedPaise / 100).toFixed(2)},${overageInr}`
        : `Program,${safeName},${safeSubType},${row.engagementsUsed},${row.overageCount}`,
    );
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `org-${orgId}-utilization.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const feedbackConsultantColumns: ResponsiveColumn<FeedbackConsultantRow>[] = [
  {
    key: "name",
    header: "Expert",
    primary: true,
    cell: (r) => <span className="font-medium">{r.name ?? "Expert"}</span>,
  },
  {
    key: "average",
    header: "Average CSAT",
    className: "tabular-nums",
    cell: (r) => (r.average !== null ? `${r.average.toFixed(1)} / 5.0` : "—"),
  },
  {
    key: "respondents",
    header: "Respondents",
    className: "tabular-nums",
    cell: (r) => r.respondents?.toLocaleString("en-IN") ?? "—",
  },
  {
    key: "responses",
    header: "Rated calls",
    className: "tabular-nums",
    cell: (r) => r.responses?.toLocaleString("en-IN") ?? "—",
  },
];

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
 * Org Analytics: membership, 6-month utilization trends, per-program
 * breakdown, and privacy-safe session quality cohorts.
 */
export function AnalyticsPageClient({ orgId }: { orgId: string }) {
  const { can } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const canReadQuality = can("quality.read");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
    enabled: allowed,
  });
  const feedbackQuery = useQuery({
    queryKey: ["org-feedback-summary", orgId],
    queryFn: () => fetchFeedbackSummary(orgId),
    enabled: allowed && canReadQuality,
  });

  if (!allowed) return null;

  const seesMoney = can("billing.read");
  const monthlySeries = data?.monthlySeries ?? [];
  const programBreakdown = data?.programBreakdown ?? [];

  const header = (
    <DashboardHeader
      title="Analytics"
      description="Membership, programs and, for finance roles, money at a glance."
      actions={
        data ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              downloadUtilizationCsv(
                orgId,
                monthlySeries,
                programBreakdown,
                seesMoney,
              )
            }
          >
            <Download className="mr-1.5 h-4 w-4" />
            Export Utilization CSV
          </Button>
        ) : undefined
      }
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

  const currency = data.capabilities.currency ?? "INR";
  const quality = feedbackQuery.data?.data;

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
        {canReadQuality && quality && (
          <Section
            title="Session quality (anonymized CSAT)"
            description={`Aggregated member ratings across completed sessions. Cohorts with fewer than ${quality.minRespondents} unique respondents are suppressed to protect employee anonymity.`}
          >
            {quality.averageRating === null ? (
              <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
                Session quality metrics will appear once at least{" "}
                <strong>{quality.minRespondents}</strong> unique members have
                submitted session ratings.
              </div>
            ) : (
              <div className="space-y-4">
                <StatRow columns={3}>
                  <Stat
                    label="All-time average rating"
                    value={`${quality.averageRating.toFixed(1)} / 5.0`}
                    hint={`${quality.respondents ?? 0} respondents · ${quality.totalResponses ?? 0} rated calls`}
                  />
                  <Stat
                    label="Last 30 days"
                    value={
                      quality.averageRating30d !== null
                        ? `${quality.averageRating30d.toFixed(1)} / 5.0`
                        : "Suppressed"
                    }
                    hint={
                      quality.averageRating30d !== null
                        ? `${quality.respondents30d ?? 0} respondents`
                        : `Requires ≥${quality.minRespondents} respondents in both windows`
                    }
                  />
                  <Stat
                    label="Suppressed expert cohorts"
                    value={quality.consultantsSuppressed}
                    hint="Cohorts below respondent floor"
                  />
                </StatRow>
                {quality.byConsultant.length > 0 && (
                  <ResponsiveTable<FeedbackConsultantRow>
                    columns={feedbackConsultantColumns}
                    rows={quality.byConsultant}
                    getRowId={(r) => r.consultantProfileId}
                  />
                )}
              </div>
            )}
          </Section>
        )}
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
