"use client";

import Link from "next/link";
import { useSearchParams, useSelectedLayoutSegment } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus, SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { DateRangeMenu } from "@/components/dashboard/DateRangeMenu";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useListParams } from "@/hooks/useListParams";
import { durationLabel } from "@/lib/support/case-format";
import { CASE_TOPICS, CASE_TOPIC_LABEL } from "@/lib/support/case-topic";
import {
  INBOX_FILTER_KEYS,
  INBOX_STATUSES,
  INBOX_VIEWS,
  INBOX_VIEW_LABEL,
  type InboxFilterKey,
  type InboxView,
} from "@/lib/support/inbox-query";
import { humanizeEnum } from "@/lib/ui/tone";
import type { InboxStats } from "@/types/support-case";
import { cn } from "@/utils/tailwind";

import { CaseList } from "./CaseList";
import { StaffSupportComposeDialog } from "./StaffSupportComposeDialog";
import { supportKeys } from "@/lib/support/support-keys";
import styles from "./support-layout.module.css";

const ANY = "any";
const withAny = (
  label: string,
  options: { value: string; label: string }[],
) => [{ value: ANY, label }, ...options];

function avgFirstResponse(s: InboxStats | undefined): string {
  if (!s) return "—";
  if (s.avgFirstResponseMs === null) return "No replies yet";
  return durationLabel(s.avgFirstResponseMs);
}

function StatsLine({
  basePath,
  className,
}: Readonly<{ basePath: string; className?: string }>) {
  const stats = useQuery({
    queryKey: supportKeys.inboxStats(),
    queryFn: async (): Promise<InboxStats> => {
      const res = await fetch("/api/staff/support-inbox/stats");
      if (!res.ok) throw new Error("Couldn't load the team stats");
      return res.json();
    },
    staleTime: 60_000,
  });
  const s = stats.data;
  const breachesHref = `${basePath}/support?view=sla-at-risk&sort=sla`;
  return (
    <dl
      className={cn(
        "flex flex-wrap gap-x-5 gap-y-1 text-sm sm:pt-1.5",
        className,
      )}
    >
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">Open cases</dt>
        <dd className="font-medium tabular-nums text-foreground">
          {s ? String(s.openCases) : "—"}
        </dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <Link
          href={breachesHref}
          className="inline-flex items-baseline gap-1.5 text-destructive underline-offset-4 hover:underline"
        >
          <dt>SLA breaches</dt>
          <dd className="font-semibold tabular-nums">
            {s ? String(s.slaBreaches) : "—"}
          </dd>
        </Link>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">{`Avg first response (${s?.windowDays ?? 7} days)`}</dt>
        <dd className="font-medium tabular-nums text-foreground">
          {avgFirstResponse(s)}
        </dd>
      </div>
    </dl>
  );
}

export function SupportInboxShell({
  children,
}: Readonly<{ children: ReactNode }>) {
  const caseKey = useSelectedLayoutSegment();
  const { basePath } = useBackofficeCapability();
  const search = useSearchParams().toString();
  const list = useListParams({ filterKeys: INBOX_FILTER_KEYS });
  const f = list.filters;
  const { zone } = useViewerZone();
  const view = (f.view as InboxView | null) ?? "needs-reply";
  const pick = (key: InboxFilterKey) => (value: string) =>
    list.setFilter(key, value === ANY ? null : value);
  const searchSuffix = search ? `?${search}` : "";
  const [composeOpen, setComposeOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchReset, setSearchReset] = useState(0);
  const activeFilterCount = INBOX_FILTER_KEYS.filter(
    (key) => key !== "view" && f[key] !== null,
  ).length;
  const clearFilters = () => {
    setSearchReset((reset) => reset + 1);
    list.setParams({
      q: "",
      filters: Object.fromEntries(
        INBOX_FILTER_KEYS.filter((key) => key !== "view").map((key) => [
          key,
          null,
        ]),
      ),
    });
  };

  return (
    <div
      className={cn(styles.inbox, "space-y-3")}
      data-case-open={Boolean(caseKey)}
    >
      <PageHeader
        title="Support inbox"
        className={cn(styles.header, "mb-0")}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <StatsLine basePath={basePath} className={styles.stats} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setComposeOpen(true)}
            >
              <Plus className="mr-1 h-4 w-4" /> New outbound request
            </Button>
          </div>
        }
      />
      <div className={cn(styles.browseTools, "space-y-3")}>
        <Tabs
          value={view}
          onValueChange={(v) =>
            list.setFilter("view", v === "needs-reply" ? null : v)
          }
        >
          <TabsList aria-label="Views">
            {INBOX_VIEWS.map((v) => (
              <TabsTrigger key={v} value={v}>
                {INBOX_VIEW_LABEL[v]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterBar
          key={searchReset}
          search={{
            label: "Search cases",
            placeholder: "Name, email, subject or reference",
            value: list.q,
            onChange: list.setQ,
          }}
          onClear={clearFilters}
          canClear={!!list.q || activeFilterCount > 0}
        >
          <Button
            size="sm"
            variant="outline"
            className={cn(styles.filterToggle, "h-9")}
            aria-expanded={filtersOpen}
            aria-controls="support-inbox-filters"
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal className="mr-1.5 h-4 w-4" aria-hidden />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
        </FilterBar>
        <div
          id="support-inbox-filters"
          className={styles.filters}
          data-expanded={filtersOpen}
        >
          <FilterBar
            selects={[
              {
                key: "sort",
                label: "Sort",
                value:
                  f.sort ??
                  (view === "needs-reply" || view === "sla-at-risk"
                    ? "sla"
                    : "activity"),
                options: [
                  { value: "activity", label: "Latest activity" },
                  { value: "sla", label: "Nearest SLA deadline" },
                ],
                onChange: pick("sort"),
              },
              {
                key: "scope",
                label: "Kind",
                value: f.scope ?? ANY,
                options: withAny("Session and platform", [
                  { value: "session", label: "Session" },
                  { value: "platform", label: "Platform" },
                ]),
                onChange: pick("scope"),
              },
              {
                key: "status",
                label: "Status",
                value: f.status ?? ANY,
                options: withAny(
                  "Any status",
                  INBOX_STATUSES.map((s) => ({
                    value: s,
                    label: humanizeEnum(s),
                  })),
                ),
                onChange: pick("status"),
              },
              {
                key: "priority",
                label: "Priority",
                value: f.priority ?? ANY,
                options: withAny(
                  "Any priority",
                  ["URGENT", "HIGH", "MEDIUM", "LOW"].map((p) => ({
                    value: p,
                    label: humanizeEnum(p),
                  })),
                ),
                onChange: pick("priority"),
              },
              {
                key: "topic",
                label: "Category",
                value: f.topic ?? ANY,
                options: withAny(
                  "Any category",
                  CASE_TOPICS.map((t) => ({
                    value: t,
                    label: CASE_TOPIC_LABEL[t],
                  })),
                ),
                onChange: pick("topic"),
              },
            ]}
          >
            <DateRangeMenu
              direction="past"
              zone={zone}
              value={{ from: f.from ?? "", to: f.to ?? "" }}
              onChange={(range) =>
                list.setParams({
                  filters: { from: range.from || null, to: range.to || null },
                })
              }
            />
          </FilterBar>
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.caseList}>
          <CaseList activeKey={caseKey} />
        </div>
        <div className={styles.reader}>
          {caseKey && (
            <Link
              href={`${basePath}/support${searchSuffix}`}
              className={cn(
                styles.backLink,
                "mb-3 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline",
              )}
            >
              ← All cases
            </Link>
          )}
          {children}
        </div>
      </div>

      <StaffSupportComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
      />
    </div>
  );
}
