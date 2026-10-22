"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type { OpsLogPage, OpsLogRow } from "@/lib/backoffice/ops-log-types";
import { OpsLogFiltersSchema, type OpsLogFilters } from "@/schemas/ops-log";
import { enumLabel } from "@/lib/labels/money-labels";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";

const FILTERS: {
  key: keyof OpsLogFilters;
  label: string;
  adminOnly?: boolean;
}[] = [
  { key: "actorUserId", label: "Actor user id", adminOnly: true },
  { key: "surface", label: "Surface" },
  { key: "targetKind", label: "Target kind" },
  { key: "targetId", label: "Target id" },
  { key: "action", label: "Action" },
  { key: "since", label: "Since (YYYY-MM-DD or ISO time)" },
];

const sameFilters = (a: OpsLogFilters, b: OpsLogFilters) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

async function fetchPage(
  filters: OpsLogFilters,
  page: number,
): Promise<OpsLogPage> {
  const params = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const res = await fetch(`/api/admin/ops-actions?${params}`);
  if (!res.ok) throw new Error("Failed to load the audit log");
  return res.json() as Promise<OpsLogPage>;
}

const columns: ResponsiveColumn<OpsLogRow>[] = [
  {
    key: "when",
    header: "When",
    primary: true,
    cell: (r) => new Date(r.createdAt).toLocaleString(),
  },
  {
    key: "actor",
    header: "Who",
    cell: (r) =>
      `${r.actorName ?? r.actorUserId ?? "Deleted user"} (${enumLabel(r.actorRole)})`,
  },
  { key: "action", header: "Action", cell: (r) => r.action },
  {
    key: "target",
    header: "Target",
    cell: (r) => `${r.targetKind} ${r.targetId}`,
  },
  { key: "reason", header: "Reason", cell: (r) => r.reason },
];

/**
 * #1771 K-9 — the console's audit log, newest first, seeded by the server
 * render. Staff see their own rows only; the API enforces it too. The URL's
 * filters seed the inputs, so other tabs can link to a filtered view.
 */
export function AuditTab({
  initial,
  initialFilters = {},
}: Readonly<{ initial: OpsLogPage; initialFilters?: OpsLogFilters }>) {
  // The read scopes by the viewer's ROLE, not the tree (ops-log-read.ts):
  // an admin in the staff tree still reads every row.
  const viewerIsAdmin = useBackofficeCapability().role === "ADMIN";
  const [filters, setFilters] = useState<OpsLogFilters>(initialFilters);
  const [page, setPage] = useState(1);
  // Blank filters leave the key, so a cleared filter is the seeded key again.
  const active = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v?.trim()),
  ) as OpsLogFilters;
  const pristine = page === 1 && sameFilters(active, initialFilters);
  // A half-typed date would read as "no rows"; hold the query until it parses.
  const sinceInvalid = !OpsLogFiltersSchema.shape.since.safeParse(active.since)
    .success;
  const { data } = useQuery({
    queryKey: ["money-audit", active, page],
    queryFn: () => fetchPage(active, page),
    initialData: pristine ? initial : undefined,
    initialDataUpdatedAt: pristine
      ? new Date(initial.fetchedAt).getTime()
      : undefined,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    enabled: !sinceInvalid,
  });
  const lastPage = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description={
          viewerIsAdmin
            ? "Operator money and administrative actions across the platform."
            : "You see the actions you took yourself."
        }
      />
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {FILTERS.filter((f) => viewerIsAdmin || !f.adminOnly).map((f) => (
              <Input
                key={f.key}
                aria-label={f.label}
                placeholder={f.label}
                value={filters[f.key] ?? ""}
                aria-invalid={f.key === "since" && sinceInvalid}
                aria-describedby={
                  f.key === "since" && sinceInvalid
                    ? "audit-since-hint"
                    : undefined
                }
                onChange={(e) => {
                  setPage(1);
                  setFilters((all) => ({ ...all, [f.key]: e.target.value }));
                }}
              />
            ))}
          </div>
          {sinceInvalid ? (
            <p id="audit-since-hint" className="text-sm text-destructive">
              Enter Since as a date (YYYY-MM-DD) or an ISO time.
            </p>
          ) : null}
          <ResponsiveTable<OpsLogRow>
            columns={columns}
            rows={sinceInvalid ? [] : (data?.rows ?? [])}
            getRowId={(r) => r.id}
            empty={
              <p className="py-8 text-center text-sm text-muted-foreground">
                {sinceInvalid
                  ? "Finish the Since date to see matching actions."
                  : "No actions match these filters."}
              </p>
            }
          />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {page} of {lastPage}
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Newer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= lastPage}
                onClick={() => setPage((p) => p + 1)}
              >
                Older
              </Button>
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
