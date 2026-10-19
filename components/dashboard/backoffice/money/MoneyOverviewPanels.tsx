"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatRupees, formatRupeesCompact } from "@/lib/backoffice/rupees";
import type {
  DisputeAging,
  LiabilityLadder,
  MoneyAtRisk,
  MoneyOverviewPayload,
  NeedsHumanMoney,
  PayoutLatency,
  ReconcileBreaks,
  RefundReasonSlice,
  StatutoryCountdown,
} from "@/lib/backoffice/money-overview";
import { formatPercent } from "./MoneyOverviewStatCards";

/**
 * One horizontal bar. A sorted bar with its count and share printed beside
 * it — never a pie, never a colour on its own.
 */
function BarRow({
  label,
  right,
  share,
  detail,
  barClassName,
  onClick,
}: Readonly<{
  label: ReactNode;
  right: ReactNode;
  share: number;
  detail?: ReactNode;
  barClassName?: string;
  onClick?: () => void;
}>) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-foreground">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {right}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        <div
          className={barClassName ?? "h-full rounded-full bg-chart-1"}
          style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
        />
      </div>
      {detail && (
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      )}
    </>
  );
  if (!onClick) return <div className="py-2">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-md py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </button>
  );
}

// ── Dispute aging ───────────────────────────────────────────────────────────

export function DisputeAgingPanel({
  aging,
  onDrill,
}: Readonly<{
  aging: DisputeAging;
  onDrill: (key: string) => void;
}>) {
  const max = Math.max(1, ...aging.buckets.map((b) => b.count));
  return (
    <Section
      variant="card"
      title="Dispute aging"
      description="Open disputes by the days left on their deadline. Click a band to see the disputes in it."
    >
      <div className="divide-y divide-border">
        {aging.buckets.map((bucket) => (
          <BarRow
            key={bucket.key}
            label={
              <span className="flex items-center gap-2">
                {bucket.label}
                {bucket.overdue > 0 && (
                  <StatusBadge
                    label={`${bucket.overdue} overdue`}
                    tone="critical"
                    size="sm"
                  />
                )}
              </span>
            }
            right={`${bucket.count} · ${formatRupeesCompact(bucket.amountPaise)}`}
            share={bucket.count / max}
            barClassName={
              bucket.overdue > 0
                ? "h-full rounded-full bg-destructive"
                : "h-full rounded-full bg-chart-1"
            }
            onClick={() => onDrill("dispute-aging")}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {aging.openCount} open · {formatRupees(aging.openAmountPaise)} in
        dispute
        {aging.noDeadlineCount > 0
          ? ` · ${aging.noDeadlineCount} carry no deadline and cannot be aged`
          : ""}
      </p>
    </Section>
  );
}

// ── Payout success + latency ───────────────────────────────────────────────

const railColumns: ResponsiveColumn<PayoutLatency["rails"][number]>[] = [
  {
    key: "rail",
    header: "Rail",
    primary: true,
    cell: (rail) =>
      rail.rail === "consultant" ? "Expert payouts" : "Org payouts",
  },
  {
    key: "created",
    header: "Raised",
    className: "text-right",
    cell: (rail) => <span className="tabular-nums">{rail.created}</span>,
  },
  {
    key: "completed",
    header: "Completed",
    className: "text-right",
    cell: (rail) => <span className="tabular-nums">{rail.completed}</span>,
  },
  {
    key: "failed",
    header: "Failed",
    className: "text-right",
    cell: (rail) => <span className="tabular-nums">{rail.failed}</span>,
  },
  {
    key: "rate",
    header: "Rate",
    className: "text-right",
    cell: (rail) => (
      <span className="tabular-nums">{formatPercent(rail.completionRate)}</span>
    ),
  },
];

export function PayoutLatencyPanel({
  latency,
  onDrill,
}: Readonly<{
  latency: PayoutLatency;
  onDrill: (key: string) => void;
}>) {
  const max = Math.max(1, ...latency.buckets.map((b) => b.count));
  return (
    <Section
      variant="card"
      title="Payout success + latency"
      description="Payouts raised in the window, and how long they took to land."
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[26px] font-semibold leading-tight tabular-nums">
          {formatPercent(latency.completionRate)}
        </span>
        <span className="text-sm text-muted-foreground">
          completed · {latency.completed} of {latency.created} raised
        </span>
        {latency.failed > 0 && (
          <StatusBadge
            label={`${latency.failed} failed`}
            tone="critical"
            size="sm"
          />
        )}
        {latency.inFlight > 0 && (
          <StatusBadge
            label={`${latency.inFlight} still open`}
            tone="info"
            size="sm"
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {latency.medianLatencyHours === null
          ? "No payout in this window has completed yet, so there is no median."
          : `Median ${formatHours(latency.medianLatencyHours)} from raised to paid.`}
      </p>

      <div className="mt-4 divide-y divide-border">
        {latency.buckets.map((bucket) => (
          <BarRow
            key={bucket.key}
            label={bucket.label}
            right={`${bucket.count}`}
            share={bucket.count / max}
            detail={`previous period: ${bucket.priorCount}`}
            onClick={() => onDrill("payout-latency")}
          />
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border">
        <ResponsiveTable
          columns={railColumns}
          rows={latency.rails}
          getRowId={(rail) => rail.rail}
        />
      </div>
    </Section>
  );
}

function formatHours(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

// ── T+N liability ladder ───────────────────────────────────────────────────

export function LiabilityLadderPanel({
  ladder,
  liabilities,
  onDrill,
}: Readonly<{
  ladder: LiabilityLadder;
  liabilities: MoneyOverviewPayload["liabilities"];
  onDrill: (key: string) => void;
}>) {
  const max = Math.max(1, ...ladder.buckets.map((b) => b.amountPaise));
  return (
    <Section
      variant="card"
      title="T+N liability ladder"
      description="Collected money that is not payable yet, by the day it becomes payable."
    >
      <div className="divide-y divide-border">
        {ladder.buckets.map((bucket) => (
          <BarRow
            key={bucket.key}
            label={bucket.label}
            right={`${formatRupeesCompact(bucket.amountPaise)} · ${bucket.count}`}
            share={bucket.amountPaise / max}
            barClassName="h-full rounded-full bg-chart-3"
            onClick={() => onDrill("liability-ladder")}
          />
        ))}
      </div>
      <dl className="mt-4 space-y-2 border-t border-border pt-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Expert earnings ready</dt>
          <dd className="tabular-nums">
            {formatRupees(ladder.consultantTotalPaise)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Org earnings ready</dt>
          <dd className="tabular-nums">
            {formatRupees(ladder.organizationTotalPaise)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Org wallet balances held</dt>
          <dd className="tabular-nums">
            {formatRupees(ladder.walletBalancePaise)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Wallet balances are a liability we owe on demand, not a scheduled
        payout.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <CountdownCard countdown={liabilities.tds} />
        <CountdownCard countdown={liabilities.gst} />
      </div>
    </Section>
  );
}

function CountdownCard({
  countdown,
}: Readonly<{ countdown: StatutoryCountdown }>) {
  const overdue = countdown.daysUntilDue < 0;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {countdown.label}
        </p>
        <StatusBadge
          label={
            overdue
              ? "Overdue"
              : countdown.daysUntilDue === 0
                ? "Due today"
                : `${countdown.daysUntilDue}d left`
          }
          tone={overdue ? "critical" : "caution"}
          size="sm"
        />
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {formatRupees(countdown.amountPaise)}
      </p>
      <p className="text-xs text-muted-foreground">
        {countdown.count} record{countdown.count === 1 ? "" : "s"} ·{" "}
        {countdown.dueLabel}
      </p>
    </div>
  );
}

// ── Reconciliation breaks ──────────────────────────────────────────────────

interface ReconcileRow {
  id: string;
  kind: string;
  scope: string;
  expectedPaise: number | null;
  actualPaise: number | null;
  deltaPaise: number | null;
  detail: string | null;
}

export function ReconcileBreaksPanel({
  reconciliation,
}: Readonly<{ reconciliation: ReconcileBreaks }>) {
  const rows: ReconcileRow[] = reconciliation.findings.map((f) => ({
    id: `${f.kind}-${f.scope}`,
    kind: f.kind,
    scope: f.scope,
    expectedPaise: f.expectedPaise,
    actualPaise: f.actualPaise,
    deltaPaise: f.deltaPaise,
    detail: f.detail,
  }));

  const columns: ResponsiveColumn<ReconcileRow>[] = [
    {
      key: "kind",
      header: "Break",
      primary: true,
      cell: (row) => <span className="font-medium">{row.kind}</span>,
    },
    {
      key: "scope",
      header: "Scope",
      cell: (row) => row.scope,
    },
    {
      key: "expected",
      header: "Expected",
      className: "text-right",
      cell: (row) =>
        row.expectedPaise === null
          ? "—"
          : formatRupees(row.expectedPaise),
    },
    {
      key: "actual",
      header: "Actual",
      className: "text-right",
      cell: (row) =>
        row.actualPaise === null ? "—" : formatRupees(row.actualPaise),
    },
    {
      key: "delta",
      header: "Delta",
      className: "text-right",
      cell: (row) =>
        row.deltaPaise === null ? (
          "—"
        ) : (
          <span className="font-medium tabular-nums text-destructive">
            {formatRupees(row.deltaPaise)}
          </span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: () => <StatusBadge label="Break" tone="critical" size="sm" />,
    },
  ];

  return (
    <Section
      variant="card"
      title="Reconciliation breaks"
      description="The last ledger reconciliation run. Zero rows is the normal state; a row is an incident."
      actions={
        <StatusBadge
          label={reconciliation.ok ? "Clean" : "Breaks found"}
          tone={reconciliation.ok ? "success" : "critical"}
          size="sm"
        />
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">
        {reconciliation.lastRunAt
          ? `Last run ${new Date(reconciliation.lastRunAt).toLocaleString("en-IN")}`
          : "The reconciler has not run yet"}
        {reconciliation.recentRuns > 0
          ? ` · ${reconciliation.recentRuns} run${reconciliation.recentRuns === 1 ? "" : "s"} in 30 days, ${reconciliation.recentFailures} with breaks`
          : ""}
      </p>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border p-4 text-sm">
          <StatusBadge label="No breaks" tone="success" size="sm" />
          <p className="mt-2 text-muted-foreground">
            Every ledger balance the reconciler checked matched its journal.
          </p>
        </div>
      ) : (
        <ResponsiveTable
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
        />
      )}
    </Section>
  );
}

// ── Needs a human ───────────────────────────────────────────────────────────

export function NeedsHumanPanel({
  needsHuman,
  refundsHref,
  onDrill,
}: Readonly<{
  needsHuman: NeedsHumanMoney;
  refundsHref: string;
  onDrill: (key: string) => void;
}>) {
  return (
    <Section
      variant="card"
      title="Needs a human"
      description="Refund-adjacent money the automatic sweeps could not settle on their own."
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-tight tabular-nums">
          {needsHuman.count}
        </span>
        <span className="text-sm text-muted-foreground">items</span>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-medium tabular-nums">
          {formatRupees(needsHuman.amountPaise)}
        </span>{" "}
        <span className="text-muted-foreground">still to be settled</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onDrill("needs-human")}>
          See the items
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href={refundsHref}>Open the Refunds tab</Link>
        </Button>
      </div>
    </Section>
  );
}

// ── Money at risk ───────────────────────────────────────────────────────────

export function MoneyAtRiskPanel({
  atRisk,
  onDrill,
}: Readonly<{
  atRisk: MoneyAtRisk;
  onDrill: (key: string) => void;
}>) {
  return (
    <Section
      variant="card"
      title="Money at risk"
      description="The amount open disputes put at stake if every one of them goes against us."
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[26px] font-semibold leading-tight tabular-nums">
          {formatRupeesCompact(atRisk.totalAmountPaise)}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Exposed, not expected loss — no loss rate is assumed.
      </p>
      <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            Gateway chargebacks ({atRisk.gatewayCount})
          </dt>
          <dd className="tabular-nums">
            {formatRupees(atRisk.gatewayAmountPaise)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">
            Buyer disputes ({atRisk.buyerCount})
          </dt>
          <dd className="tabular-nums">
            {formatRupees(atRisk.buyerAmountPaise)}
          </dd>
        </div>
      </dl>
      <Button
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={() => onDrill("at-risk")}
      >
        See the open disputes
      </Button>
    </Section>
  );
}

// ── Refund rate by reason ──────────────────────────────────────────────────

export function RefundReasonsPanel({
  reasons,
  onDrill,
}: Readonly<{
  reasons: RefundReasonSlice[];
  onDrill: (key: string, reason?: string) => void;
}>) {
  const max = Math.max(1, ...reasons.map((r) => r.amountPaise));
  if (reasons.length === 0) {
    return (
      <Section
        variant="card"
        title="Refund rate by reason"
        description="Why money went back, split by the reason code on the refund."
      >
        <p className="text-sm text-muted-foreground">
          No refund was issued in this window.
        </p>
      </Section>
    );
  }
  return (
    <Section
      variant="card"
      title="Refund rate by reason"
      description="Why money went back, split by the reason code on the refund."
    >
      <div className="max-h-[320px] divide-y divide-border overflow-y-auto">
        {reasons.map((slice) => (
          <BarRow
            key={slice.reason}
            label={slice.label}
            right={`${slice.count} · ${formatPercent(slice.share)}`}
            share={slice.amountPaise / max}
            barClassName="h-full rounded-full bg-chart-4"
            detail={`${formatRupees(slice.amountPaise)} refunded · ${formatPercent(slice.countShare)} of refunds · previous period: ${slice.priorCount}`}
            onClick={() => onDrill("refund-reason", slice.reason)}
          />
        ))}
      </div>
    </Section>
  );
}
