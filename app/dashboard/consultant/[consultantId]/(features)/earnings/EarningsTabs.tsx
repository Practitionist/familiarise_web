"use client";

import { UrlTabs } from "@/components/dashboard/UrlTabs";
import AnalyticsPageClient from "../analytics/AnalyticsPageClient";
import { EarningsSummaryPanel } from "./EarningsSummaryPanel";

/**
 * Earnings, with Analytics as its second panel.
 *
 * ADR 19: a navigation entry must be a distinct destination. Analytics was a
 * second sidebar entry over the same object — it called the same
 * `/api/consultant/earnings` endpoint, only adding `?includeMonthly=1` — which
 * is the pattern the rule exists to stop. Both panels keep their own filter and
 * pagination state, deliberately: they answer different questions and resetting
 * one when the other moves would be surprising.
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
          value: "analytics",
          label: "Analytics",
          content: <AnalyticsPageClient consultantId={consultantId} />,
        },
      ]}
    />
  );
}
