"use client";

import { use, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Filter, Search } from "lucide-react";
import type { OrgAuditCategory } from "@prisma/client";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { humanizeEnum } from "@/lib/ui/tone";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

/**
 * /dashboard/organization/[orgId]/audit — org audit-log browser.
 *
 * MAINTAINER+ role-gated (matches the API endpoint). Renders a
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
  // audit.read (OWNER/MAINTAINER/SUPPORT) — same matrix entry the sidebar
  // and the audit GET API check, so SUPPORT's ticket-investigation read
  // works and an EXPERT/LEARNER/BILLING_ADMIN direct URL bounces to /home.
  const { allowed, isLoading: isGateLoading } = useRequireOrgAccess(orgId, {
    permission: "audit.read",
  });
  // The export route floors at MAINTAINER, so SUPPORT reads but can't export.
  const { isAtLeast } = useOrgRole(orgId);
  const canExport = isAtLeast("MAINTAINER");

  const [category, setCategory] = useState<OrgAuditCategory | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [cursorStack, setCursorStack] = useState<string[]>([]); // back-navigation

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (category !== "ALL") p.set("categories", category);
    if (search.trim()) p.set("q", search.trim());
    if (from) p.set("from", new Date(from).toISOString());
    if (to) p.set("to", new Date(to).toISOString());
    const current = cursorStack[cursorStack.length - 1];
    if (current) p.set("cursor", current);
    return p.toString();
  }, [category, search, from, to, cursorStack]);

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
              The audit log is available to owners, maintainers and support
              staff.
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
    setFrom("");
    setTo("");
    setCursorStack([]);
  };

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
        <Badge variant="secondary">{humanizeEnum(row.category)}</Badge>
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
        title="Audit log"
        description="Every change in your organization, with who made it and when."
      />
      <DashboardContent>
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4" /> Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <div className="min-w-0 flex-1">
                <div className="relative">
                  <Search className="h-4 w-4 absolute left-3 top-2.5 text-muted-foreground/70" />
                  <Input
                    aria-label="Search description"
                    placeholder="Search description…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setCursorStack([]);
                    }}
                    className="pl-9"
                  />
                </div>
              </div>
              <Select
                value={category}
                onValueChange={(v) => {
                  setCategory(v as OrgAuditCategory | "ALL");
                  setCursorStack([]);
                }}
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All categories</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {humanizeEnum(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setCursorStack([]);
                }}
                className="w-full sm:w-40"
                aria-label="From date"
              />
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setCursorStack([]);
                }}
                className="w-full sm:w-40"
                aria-label="To date"
              />
              <Button variant="outline" onClick={resetFilters}>
                Reset
              </Button>
              {canExport && (
                <Button
                  variant="outline"
                  onClick={onDownloadCsv}
                  disabled={isFetching}
                >
                  <Download className="h-4 w-4 mr-1" />
                  CSV
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

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
