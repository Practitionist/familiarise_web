"use client";

import { useQuery } from "@tanstack/react-query";

import { useScrollToHashOnReady } from "@/hooks/useScrollToHashOnReady";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EmptyState } from "@/components/dashboard/EmptyState";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  AWAITING_ORG_HINT,
  AWAITING_ORG_LABEL,
} from "@/lib/dashboard/hold-copy";

interface OrgEarningRow {
  id: string;
  status: string;
  currency: string;
  grossAmountPaise: number;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
  refundedAmountPaise: number;
  createdAt: string;
}

interface OrgEarningAggregate {
  status: string;
  count: number;
  orgSharePaise: number;
}

interface OrgEarningsResponse {
  data: OrgEarningRow[];
  aggregates: OrgEarningAggregate[];
}

/** The org's share of each split, from the org's side (EarningStatus). */
const EARNING_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "In hold period", tone: "caution" },
  HELD: { label: "Held for a dispute", tone: "caution" },
  READY: { label: "Ready for a batch", tone: "info" },
  BATCHED: { label: "In a payout batch", tone: "info" },
  PAID: { label: "Paid out", tone: "success" },
  PENDING_TRUST: { label: AWAITING_ORG_LABEL, tone: "caution" },
  REFUNDED: { label: "Refunded", tone: "neutral" },
};

const columns: ResponsiveColumn<OrgEarningRow>[] = [
  {
    key: "date",
    header: "Date",
    primary: true,
    cell: (r) => new Date(r.createdAt).toLocaleDateString("en-IN"),
  },
  {
    key: "gross",
    header: "Booking",
    className: "tabular-nums",
    cell: (r) => formatCurrencyAmount(r.grossAmountPaise, r.currency),
  },
  {
    key: "org",
    header: "Organization share",
    className: "tabular-nums font-medium",
    cell: (r) => formatCurrencyAmount(r.orgSharePaise, r.currency),
  },
  {
    key: "expert",
    header: "Expert share",
    className: "tabular-nums text-muted-foreground",
    cell: (r) => formatCurrencyAmount(r.consultantSharePaise, r.currency),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => {
      const s = EARNING_STATUS[r.status];
      return (
        <StatusBadge
          label={s?.label ?? humanizeEnum(r.status)}
          tone={s?.tone ?? "neutral"}
        />
      );
    },
  },
];

const sumShare = (aggs: OrgEarningAggregate[], statuses: string[]) =>
  aggs
    .filter((a) => statuses.includes(a.status))
    .reduce((total, a) => total + a.orgSharePaise, 0);

/**
 * Payouts › Earnings (#1527): the per-booking split behind every payout run,
 * read from GET …/earnings. Each row is immutable once written, so the split
 * shown is the one settlement used.
 */
export function OrgEarningsPanel({
  orgId,
  anchorId,
}: Readonly<{ orgId: string; anchorId?: string }>) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["org-earnings", orgId],
    queryFn: async (): Promise<OrgEarningsResponse> => {
      const res = await fetch(`/api/organizations/${orgId}/earnings?limit=50`);
      // 404 = hosting earnings are switched off for this org (ENABLE_HOST_ORGS).
      if (res.status === 404) return { data: [], aggregates: [] };
      if (!res.ok) throw new Error("Failed to load earnings");
      return res.json();
    },
  });

  useScrollToHashOnReady(anchorId, !isPending);

  if (isPending) {
    return (
      <StatRow columns={3}>
        <StatSkeleton />
        <StatSkeleton />
        <StatSkeleton />
      </StatRow>
    );
  }
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load earnings"
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }

  const aggs = data.aggregates;
  const awaitingOrg = sumShare(aggs, ["PENDING_TRUST"]);
  return (
    <>
      <StatRow columns={awaitingOrg > 0 ? 4 : 3}>
        <Stat
          label="On hold"
          value={formatCurrencyAmount(
            sumShare(aggs, ["PENDING", "HELD"]),
            "INR",
          )}
          hint="Inside the refund window or a dispute"
        />
        <Stat
          label="Ready or batched"
          value={formatCurrencyAmount(
            sumShare(aggs, ["READY", "BATCHED"]),
            "INR",
          )}
          tone="info"
        />
        {awaitingOrg > 0 && (
          <Stat
            label={AWAITING_ORG_LABEL}
            value={formatCurrencyAmount(awaitingOrg, "INR")}
            hint={AWAITING_ORG_HINT}
          />
        )}
        <Stat
          label="Paid out (before TDS)"
          value={formatCurrencyAmount(sumShare(aggs, ["PAID"]), "INR")}
          hint="The organisation's share; the amount received after TDS is on Runs"
          tone="success"
        />
      </StatRow>
      <Section title="Recent earnings">
        <ResponsiveTable<OrgEarningRow>
          columns={columns}
          rows={data.data}
          getRowId={(r) => r.id}
          empty={
            <EmptyState
              title="No earnings yet"
              description="Each paid booking of this organization's offerings adds its share here."
            />
          }
        />
      </Section>
    </>
  );
}
