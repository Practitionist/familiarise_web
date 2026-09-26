"use client";

import { useQuery } from "@tanstack/react-query";

import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { formatCurrencyAmount } from "@/utils/formatting";

interface EarningsTotals {
  totals: { available: number; pending: number; paidOut: number };
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
    <StatRow columns={3}>
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
      <Stat
        label="Paid out"
        value={formatCurrencyAmount(data.totals.paidOut, "INR")}
        hint="Across all your payouts"
      />
    </StatRow>
  );
}
