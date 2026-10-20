"use client";

import { useQuery } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { formatCurrencyAmount } from "@/utils/formatting";
import {
  AWAITING_ORG_HINT,
  AWAITING_ORG_LABEL,
  newExpertHoldCopy,
} from "@/lib/dashboard/hold-copy";

interface EarningsTotals {
  totals: {
    available: number;
    pending: number;
    paidOut: number;
    awaitingOrg: number;
  };
}

/**
 * #1527 §13 — the expert's own earnings under this organization, from the
 * personal earnings API's org scope (`?orgScope=<orgId>`, membership-checked
 * server-side). Paid out is account-wide: payouts batch across scopes.
 */
export function OrgScopedEarnings({
  orgId,
  orgName,
}: Readonly<{ orgId: string; orgName: string }>) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["consultant-earnings-org", orgId],
    queryFn: async (): Promise<EarningsTotals> => {
      const res = await fetch(
        `/api/consultant/earnings?orgScope=${encodeURIComponent(orgId)}&limit=1`,
      );
      if (!res.ok) throw new Error("Failed to load earnings");
      return res.json();
    },
  });

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
        title="Couldn't load your earnings"
        onRetry={() => void refetch()}
      />
    );
  }
  return (
    <>
      <StatRow columns={data.totals.awaitingOrg > 0 ? 4 : 3}>
        <Stat
          label="Available"
          value={formatCurrencyAmount(data.totals.available, "INR")}
          hint={`Earned under ${orgName}, ready for your next payout`}
        />
        <Stat
          label="Pending"
          value={formatCurrencyAmount(data.totals.pending, "INR")}
          hint="Inside the refund window"
        />
        {data.totals.awaitingOrg > 0 && (
          <Stat
            label={AWAITING_ORG_LABEL}
            value={formatCurrencyAmount(data.totals.awaitingOrg, "INR")}
            hint={AWAITING_ORG_HINT}
          />
        )}
        <Stat
          label="Paid out (after TDS)"
          value={formatCurrencyAmount(data.totals.paidOut, "INR")}
          hint="Across all your payouts"
        />
      </StatRow>
      {data.totals.pending > 0 && (
        <p className="text-xs text-muted-foreground">{newExpertHoldCopy()}</p>
      )}
    </>
  );
}
