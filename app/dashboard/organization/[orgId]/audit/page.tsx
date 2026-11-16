"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import type { OrgAuditCategory } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { FilterBar } from "@/components/dashboard/FilterBar";
import {
  DateRangeMenu,
  dateRangeBounds,
  type DateRange,
} from "@/components/dashboard/DateRangeMenu";
import { Button } from "@/components/ui/button";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { Badge } from "@/components/ui/badge";
import { humanizeEnum } from "@/lib/ui/tone";
import { ORG_AUDIT_CATEGORY_LABEL } from "@/lib/labels/org-labels";
import { visibleAuditCategories } from "@/lib/enterprise/audit-visibility";
import { Card, CardContent } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

/**
 * /dashboard/organization/[orgId]/audit — org audit-log browser.
 *
 * `audit.read`-gated (matches the API endpoint), rows scoped per category
 * grant server-side (#1527: money rows for money readers only). Renders a
 * paginated table of `OrgAuditLog` rows with filters for category +
 * freetext search + date range. The "Download CSV" button hits the
 * export endpoint which streams the full filtered result + emits
 * its own AUDIT_LOG_EXPORTED row.
 *
 * Filters are deliberately kept simple (category + search + date).
 * Actor dropdown + action multi-select are P1 follow-ups when we have
 * customer feedback on which filters actually get used.
 */

type PageProps = {
  params: Promise<{ orgId: string }>;
};

const CATEGORIES: OrgAuditCategory[] = [
  "MEMBER",
  "CONTRACT",
  "PROGRAM",
  "WALLET",
  "INVOICE",
  "PAYOUT",
  "SETTINGS",
  "CONSENT",
  "CATALOG",
  "SYSTEM",
  // PR #655 — outbound-webhook lifecycle rows.
  "WEBHOOK",
];

type AuditRow = {
  id: string;
  category: OrgAuditCategory;
  action: string;
  description: string;
  details: unknown;
  createdAt: string;
  actor: { role: string; user: { name: string; email: string } } | null;
  actorKind?: "member" | "platform_admin" | "former_member" | "system";
  target: { role: string; user: { name: string; email: string } } | null;
};

const ACTOR_KIND_LABEL: Record<NonNullable<AuditRow["actorKind"]>, string> = {
  member: "Member",
  platform_admin: "Platform admin",
  former_member: "Former member",
  system: "System",
};

type AuditResponse = {
  rows: AuditRow[];
  nextCursor: string | null;
};

export default function AuditLogPage({ params }: Readonly<PageProps>) {
  const { orgId } = use(params);
  const { zone } = useViewerZone();
  // audit.read — same matrix entry the sidebar and the audit GET API check;
  // an EXPERT/LEARNER direct URL bounces to /home.
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, {
    permission: "audit.read",
  });
  // The CSV is part of the people export (dataExports.people, #1527), so
  // SUPPORT, MANAGER and BILLING_ADMIN read but can't export.
  const { can, role } = useOrgRole(orgId);
  const canExport = can("dataExports.people");
  // Only offer categories whose rows this role can read (#1527 audit split).
  const categories = visibleAuditCategories(role, CATEGORIES);

  const [category, setCategory] = useState<OrgAuditCategory | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [cursorStack, setCursorStack] = useState<string[]>([]); // back-navigation

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (category !== "ALL") p.set("categories", category);
    if (search.trim()) p.set("q", search.trim());
    // Viewer-zone day bounds: the first day from its start, the last through its final millisecond.
    const { fromMs, toMs } = dateRangeBounds(range, zone);
    if (fromMs !== null) p.set("from", new Date(fromMs).toISOString());
    if (toMs !== null) p.set("to", new Date(toMs).toISOString());
    const current = cursorStack[cursorStack.length - 1];
    if (current) p.set("cursor", current);
    return p.toString();
  }, [category, search, range, cursorStack, zone]);

  const { data, isLoading, isFetching } = useQuery<AuditResponse>({
    queryKey: ["org-audit-log", orgId, queryString],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/audit?${queryString}`);
      if (!r.ok) throw new Error("Failed to fetch audit log");
      return (await r.json()) as AuditResponse;
    },
    enabled: allowed,
  });

  if (isGateLoading) {
    return (
      <DashboardContent>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </DashboardContent>
    );
  }

  if (!allowed) {
    // The effect above dispatches a router.replace to /home on gate
    // failure; this branch is a defensive fallback that renders briefly
    // during the redirect.
    return (
      <DashboardContent>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-foreground">
              The audit log is available to owners, maintainers, managers,
              billing admins and support staff.
            </p>
          </CardContent>
        </Card>
      </DashboardContent>
    );
  }

  const onDownloadCsv = () => {
    // Browser handles the stream; reuse current filters.
    const p = new URLSearchParams(queryString);
    // Never carry the cursor into the export — we want the full result
    // set, not the current page.
    p.delete("cursor");
    const url = `/api/organizations/${orgId}/audit/export?${p.toString()}`;
    window.location.href = url;
  };

  const resetFilters = () => {
    setCategory("ALL");
    setSearch("");
    setRange({ from: "", to: "" });
    setCursorStack([]);
  };
  const isFiltered =
    category !== "ALL" ||
    search.trim() !== "" ||
    range.from !== "" ||
    range.to !== "";

  const rows = data?.rows ?? [];
  const canGoPrev = cursorStack.length > 0;
  const canGoNext = !!data?.nextCursor;

  const columns: ResponsiveColumn<AuditRow>[] = [
    {
      key: "time",
      header: "Time",
      primary: true,
      className: "font-mono text-xs whitespace-nowrap",
      cell: (row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      key: "category",
      header: "Category",
      // A neutral taxonomy, not a status: plain chips (#1762-4).
      cell: (row) => (
        <Badge variant="secondary">
          {ORG_AUDIT_CATEGORY_LABEL[row.category]}
        </Badge>
      ),
    },
    {
      key: "action",
      header: "Action",
      className: "text-xs",
      cell: (row) => humanizeEnum(row.action),
    },
    {
      key: "actor",
      header: "Actor",
      className: "text-xs",
      cell: (row) =>
        row.actor ? (
          <>
            <div className="font-medium">{row.actor.user.name}</div>
            <div className="text-muted-foreground">{row.actor.user.email}</div>
          </>
        ) : (
          <span className="text-muted-foreground">
            {ACTOR_KIND_LABEL[row.actorKind ?? "system"]}
          </span>
        ),
    },
    {
      key: "description",
      header: "Description",
      className: "text-sm",
      cell: (row) => row.description,
    },
  ];

  return (
    <>
      <DashboardHeader
        title="Audit"
        description="Every change in your organization, with who made it and when."
      />
      <DashboardContent>
        <FilterBar
          className="mb-4"
          search={{
            label: "Search description",
            placeholder: "Search description…",
            value: search,
            onChange: (v) => {
              setSearch(v);
              setCursorStack([]);
            },
          }}
          selects={[
            {
              key: "category",
              label: "Category",
              value: category,
              options: [
                { value: "ALL", label: "All categories" },
                ...categories.map((c) => ({
                  value: c,
                  label: ORG_AUDIT_CATEGORY_LABEL[c],
                })),
              ],
              onChange: (v) => {
                setCategory(categories.find((c) => c === v) ?? "ALL");
                setCursorStack([]);
              },
            },
          ]}
          onClear={resetFilters}
          canClear={isFiltered}
        >
          <DateRangeMenu
            value={range}
            onChange={(next) => {
              setRange(next);
              setCursorStack([]);
            }}
            zone={zone}
            direction="past"
          />
          {canExport && (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={onDownloadCsv}
              disabled={isFetching}
            >
              <Download className="h-4 w-4 mr-1" />
              CSV
            </Button>
          )}
        </FilterBar>

        <Card>
          <CardContent className="p-0 sm:p-4">
            {isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            ) : (
              <ResponsiveTable<AuditRow>
                columns={columns}
                rows={rows}
                getRowId={(row) => row.id}
                empty={
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No audit rows match the current filters.
                  </p>
                }
              />
            )}
          </CardContent>
        </Card>

        <div className="flex justify-between items-center mt-3 text-sm text-muted-foreground">
          <span>
            {rows.length} row{rows.length === 1 ? "" : "s"}
            {isFetching && " · refreshing…"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canGoPrev}
              onClick={() => setCursorStack((s) => s.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canGoNext}
              onClick={() =>
                data?.nextCursor &&
                setCursorStack((s) => [...s, data.nextCursor!])
              }
            >
              Next
            </Button>
          </div>
        </div>
      </DashboardContent>
    </>
  );
}
