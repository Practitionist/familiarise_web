"use client";

import { Stat } from "@/components/dashboard/Stat";
import { formatRupees, formatRupeesCompact } from "@/lib/backoffice/rupees";
import type {
  MoneyMetric,
  MoneyOverviewPayload,
} from "@/lib/backoffice/money-overview";

/**
 * The five headline numbers, each with its comparison against the previous
 * period and each opening the rows behind it.
 *
 * The tiles stay neutral on purpose: a rate that rose is not a breach, and
 * colouring a dashboard red for every wobble is how a queue stops being read.
 * Severity lives in the panels below, where it means something.
 */
export function MoneyOverviewStatCards({
  stats,
  grossUp,
  baselineLabel,
  onDrill,
}: Readonly<{
  stats: MoneyOverviewPayload["stats"];
  grossUp: MoneyOverviewPayload["grossUp"];
  baselineLabel: string;
  onDrill: (key: string) => void;
}>) {
  const withoutFeeRate =
    grossUp.paymentsWithoutFeeRate > 0
      ? ` · ${grossUp.paymentsWithoutFeeRate} collected payments carry no stamped fee rate, so they add nothing to the fee`
      : "";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Stat
          label="GMV"
          value={formatRupeesCompact(stats.gmv.current)}
          hint={deltaHint(stats.gmv, baselineLabel)}
          onClick={() => onDrill("gmv")}
        />
        <Stat
          label="Net revenue"
          value={formatRupeesCompact(stats.netRevenue.current)}
          hint={deltaHint(stats.netRevenue, baselineLabel)}
          onClick={() => onDrill("net-revenue")}
        />
        <Stat
          label="Take rate"
          value={formatPercent(stats.takeRate.current)}
          hint={deltaHint(stats.takeRate, baselineLabel)}
          onClick={() => onDrill("net-revenue")}
        />
        <Stat
          label="Refund rate"
          value={formatPercent(stats.refundRate.current)}
          hint={deltaHint(stats.refundRate, baselineLabel)}
          onClick={() => onDrill("refund-rate")}
        />
        <Stat
          label="Dispute rate"
          value={formatPercent(stats.disputeRate.current)}
          hint={deltaHint(stats.disputeRate, baselineLabel)}
          onClick={() => onDrill("dispute-rate")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Net revenue = platform fee {formatRupees(grossUp.platformFeePaise)} −
        discounts funded {formatRupees(grossUp.discountPaise)} − fee given
        back on refunds {formatRupees(grossUp.refundedFeePaise)}
        {withoutFeeRate}.
      </p>
    </div>
  );
}

/** A rate as a percentage: 0.0734 → "7.34%". */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function deltaHint(metric: MoneyMetric, baselineLabel: string): string {
  if (metric.unit === "ratio") {
    const points = metric.delta * 100;
    const sign = points > 0 ? "+" : points < 0 ? "−" : "";
    return `${baselineLabel}: ${sign}${Math.abs(points).toFixed(2)} pp`;
  }
  if (metric.deltaPct === null) {
    return `${baselineLabel}: nothing to compare against`;
  }
  const sign = metric.deltaPct > 0 ? "+" : metric.deltaPct < 0 ? "−" : "";
  return `${baselineLabel}: ${sign}${Math.abs(metric.deltaPct * 100).toFixed(1)}%`;
}
