"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Section } from "@/components/dashboard/Section";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import {
  MONEY_OVERVIEW_PERIODS,
  moneyOverviewResponseSchema,
  type MoneyDrillWire,
  type MoneyOverviewWire,
} from "@/schemas/money-overview";

import { MoneyOverviewDrill } from "./MoneyOverviewDrill";
import {
  DisputeAgingPanel,
  LiabilityLadderPanel,
  MoneyAtRiskPanel,
  NeedsHumanPanel,
  PayoutLatencyPanel,
  ReconcileBreaksPanel,
  RefundReasonsPanel,
} from "./MoneyOverviewPanels";
import { MoneyOverviewStatCards } from "./MoneyOverviewStatCards";

// Lazy-load recharts so it stays out of this route's first-load JS.
const MoneyOverviewTrendChart = dynamic(() => import("./MoneyOverviewTrendChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[260px] w-full animate-pulse rounded-md bg-muted" />
  ),
});

/**
 * Which row of the page a drill-through belongs under, so the rows open
 * beside the number that was clicked rather than at the top of the page.
 */
const DRILL_SECTION: Record<string, string> = {
  gmv: "row1",
  "net-revenue": "row1",
  "refund-rate": "row1",
  "dispute-rate": "row1",
  "dispute-aging": "row2",
  "payout-latency": "row2",
  "liability-ladder": "row3",
  "needs-human": "row4",
  "at-risk": "row4",
  "refund-reason": "row4",
};

const PERIOD_LABEL: Record<number, string> = {
  7: "Last 7 days",
  30: "Last 30 days",
  90: "Last 90 days",
};

export function MoneyOverview({
  overview,
}: Readonly<{ overview: MoneyOverviewWire }>) {
  const { basePath } = useBackofficeCapability();
  const [data, setData] = useState<MoneyOverviewWire>(overview);
  const [days, setDays] = useState<number>(overview.period.days);
  const [drill, setDrill] = useState<{
    section: string;
    payload: MoneyDrillWire;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async (nextDays: number) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/money-overview?days=${nextDays}`,
      );
      if (!response.ok) throw new Error("The overview request failed");
      const body: unknown = await response.json();
      const parsed = moneyOverviewResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error("The overview response did not match its schema");
      }
      setData(parsed.data.overview);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load the money overview",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const openDrill = useCallback(
    async (key: string, reason?: string) => {
      setBusy(true);
      setError(null);
      try {
        const query = new URLSearchParams({ days: String(days), drill: key });
        if (reason !== undefined) query.set("reason", reason);
        const response = await fetch(`/api/admin/money-overview?${query}`);
        if (!response.ok) throw new Error("The drill-through request failed");
        const body: unknown = await response.json();
        const parsed = moneyOverviewResponseSchema.safeParse(body);
        if (!parsed.success || !parsed.data.drill) {
          throw new Error("The drill-through response did not match its schema");
        }
        setDrill({
          section: DRILL_SECTION[key] ?? "row1",
          payload: parsed.data.drill,
        });
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not open the rows behind that number",
        );
      } finally {
        setBusy(false);
      }
    },
    [days],
  );

  const onPeriodChange = (value: string) => {
    const next = Number(value);
    setDays(next);
    setDrill(null);
    void loadOverview(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Money overview"
        description="What came in, what is owed, and what is at risk. Every figure opens the rows behind it."
        actions={
          <Select value={String(days)} onValueChange={onPeriodChange}>
            <SelectTrigger className="w-[180px]" aria-label="Comparison window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONEY_OVERVIEW_PERIODS.map((period) => (
                <SelectItem key={period} value={String(period)}>
                  {PERIOD_LABEL[period]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {/* Row 1 — the five headline numbers, and the chart they share. */}
      <section className="space-y-4">
        <MoneyOverviewStatCards
          stats={data.stats}
          grossUp={data.grossUp}
          baselineLabel={data.period.baselineLabel}
          onDrill={(key) => void openDrill(key)}
        />
        {drill?.section === "row1" && (
          <MoneyOverviewDrill
            drill={drill.payload}
            onClose={() => setDrill(null)}
          />
        )}
        <Section
          variant="card"
          title="GMV vs net revenue"
          description={`Collected money and what the platform kept, day by day, against ${data.period.baselineLabel.toLowerCase()}.`}
        >
          {busy ? (
            <div className="h-[260px] w-full animate-pulse rounded-md bg-muted" />
          ) : (
            <MoneyOverviewTrendChart series={data.series} />
          )}
        </Section>
      </section>

      {/* Row 2 — disputes and payouts. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DisputeAgingPanel
          aging={data.disputeAging}
          onDrill={(key) => void openDrill(key)}
        />
        <PayoutLatencyPanel
          latency={data.payoutLatency}
          onDrill={(key) => void openDrill(key)}
        />
      </div>
      {drill?.section === "row2" && (
        <MoneyOverviewDrill drill={drill.payload} onClose={() => setDrill(null)} />
      )}

      {/* Row 3 — what we owe, and whether the books balance. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <LiabilityLadderPanel
          ladder={data.liabilityLadder}
          liabilities={data.liabilities}
          onDrill={(key) => void openDrill(key)}
        />
        <ReconcileBreaksPanel reconciliation={data.reconciliation} />
      </div>
      {drill?.section === "row3" && (
        <MoneyOverviewDrill drill={drill.payload} onClose={() => setDrill(null)} />
      )}

      {/* Row 4 — what still needs a person. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <NeedsHumanPanel
          needsHuman={data.needsHuman}
          refundsHref={`${basePath}/money/refunds`}
          onDrill={(key) => void openDrill(key)}
        />
        <MoneyAtRiskPanel
          atRisk={data.atRisk}
          onDrill={(key) => void openDrill(key)}
        />
        <RefundReasonsPanel
          reasons={data.refundReasons}
          onDrill={(key, reason) => void openDrill(key, reason)}
        />
      </div>
      {drill?.section === "row4" && (
        <MoneyOverviewDrill drill={drill.payload} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}
