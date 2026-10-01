"use client";

import dynamic from "next/dynamic";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { EarningsSummaryPanel } from "./EarningsSummaryPanel";

const AnalyticsPanel = dynamic(() => import("./AnalyticsPanel"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      Loading analytics…
    </div>
  ),
});

/**
 * Earnings: Summary · Activity · Analytics (#1527 §13b).
 *
 * ADR 19: a navigation entry must be a distinct destination, so Analytics is
 * a tab here rather than a sidebar item over the same object. Summary answers
 * "when do I get paid", Activity is the row-by-row list, Analytics the trend.
 * Analytics (recharts) is code-split so the other tabs do not pay for the
 * charting library on first paint.
 */
export function EarningsTabs({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  return (
    <UrlTabs
      tabs={[
        {
          value: "summary",
          label: "Summary",
          content: <EarningsSummaryPanel consultantId={consultantId} />,
        },
        {
          value: "activity",
          label: "Activity",
          content: (
            <EarningsSummaryPanel consultantId={consultantId} view="activity" />
          ),
        },
        {
          value: "analytics",
          label: "Analytics",
          content: <AnalyticsPanel consultantId={consultantId} />,
        },
      ]}
    />
  );
}
