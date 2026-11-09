import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";

import type { HomeNeedsItem } from "./home-model";

/**
 * What is waiting on the expert, most urgent first. The same banners as every
 * other dashboard: red for critical, amber for warning, blue for info, each
 * with one action.
 */
export function NeedsYou({ items }: Readonly<{ items: HomeNeedsItem[] }>) {
  return (
    <ActionRequiredPanel
      heading="Needs you"
      className="space-y-2"
      items={items.map((item) => ({
        key: item.key,
        severity: item.severity,
        title: item.text,
        body: item.detail ?? "",
        ctaLabel: item.ctaLabel,
        ctaHref: item.href,
      }))}
      emptyState={
        <p className="text-sm text-muted-foreground">
          You&apos;re all caught up.
        </p>
      }
    />
  );
}
