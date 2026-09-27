"use client";

import Link from "next/link";
import { useSearchParams, useSelectedLayoutSegment } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Input } from "@/components/ui/input";
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

const ANY = "any";
const withAny = (
  label: string,
  options: { value: string; label: string }[],
) => [{ value: ANY, label }, ...options];

/** #1527 — the neutral stats line: counts, not colourful KPI tiles. */
function StatsLine() {
  const stats = useQuery({
    queryKey: ["support-inbox-stats"],
    queryFn: async (): Promise<InboxStats> => {
      const res = await fetch("/api/staff/support-inbox/stats");
      if (!res.ok) throw new Error("Couldn't load the team stats");
      return res.json();
    },
    staleTime: 60_000,
  });
  const s = stats.data;
  const items: [string, string][] = [
    ["Open cases", s ? String(s.openCases) : "—"],
    ["SLA breaches", s ? String(s.slaBreaches) : "—"],
    [
      `Avg first response (${s?.windowDays ?? 7} days)`,
      s ? durationLabel(s.avgFirstResponseMs) : "—",
    ],
  ];
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * #1527 — the Support inbox: tickets and conversations as one list of cases.
 * At lg+ the list stays on the left and the case route renders on the right;
 * below lg they are separate pages. Views and filters live in the URL
 * (useListParams), so a case URL carries them and Back/forward restore both.
 */
export function SupportInboxShell({ children }: { children: ReactNode }) {
  const caseKey = useSelectedLayoutSegment();
  const { basePath } = useBackofficeCapability();
  const search = useSearchParams().toString();
  const list = useListParams({ filterKeys: INBOX_FILTER_KEYS });
  const f = list.filters;
  const view = (f.view as InboxView | null) ?? "needs-reply";
  const pick = (key: InboxFilterKey) => (value: string) =>
    list.setFilter(key, value === ANY ? null : value);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Support inbox"
        description="Tickets and session conversations as one list of cases."
      />
      <div className={cn("space-y-4", caseKey && "hidden lg:block")}>
        <StatsLine />
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
          search={{
            label: "Search cases",
            placeholder: "Name, email, subject or reference",
            value: list.q,
            onChange: list.setQ,
          }}
          selects={[
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
          // The view is a tab, not a filter: Clear keeps it.
          onClear={() =>
            list.setParams({
              q: "",
              filters: Object.fromEntries(
                INBOX_FILTER_KEYS.filter((k) => k !== "view").map((k) => [
                  k,
                  null,
                ]),
              ),
            })
          }
          canClear={
            !!list.q ||
            INBOX_FILTER_KEYS.some((k) => k !== "view" && f[k] !== null)
          }
        >
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            From
            <Input
              type="date"
              className="h-9 w-auto"
              value={f.from ?? ""}
              onChange={(e) => list.setFilter("from", e.target.value || null)}
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            To
            <Input
              type="date"
              className="h-9 w-auto"
              value={f.to ?? ""}
              onChange={(e) => list.setFilter("to", e.target.value || null)}
            />
          </label>
        </FilterBar>
      </div>

      <div className="lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className={cn(caseKey && "hidden lg:block")}>
          <CaseList activeKey={caseKey} />
        </div>
        <div className={cn(!caseKey && "hidden lg:block")}>
          {caseKey && (
            <Link
              href={`${basePath}/support${search ? `?${search}` : ""}`}
              className="mb-3 inline-block text-sm text-muted-foreground underline-offset-4 hover:underline lg:hidden"
            >
              ← All cases
            </Link>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
