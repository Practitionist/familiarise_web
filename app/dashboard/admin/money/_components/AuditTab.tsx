"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import type {
  OpsLogFilters,
  OpsLogPage,
  OpsLogRow,
} from "@/lib/backoffice/ops-log-types";
import { enumLabel } from "@/lib/labels/money-labels";

const FILTERS: {
  key: keyof OpsLogFilters;
  label: string;
  adminOnly?: boolean;
}[] = [
  { key: "actorUserId", label: "Actor user id", adminOnly: true },
  { key: "surface", label: "Surface" },
  { key: "targetKind", label: "Target kind" },
  { key: "targetId", label: "Target id" },
];

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
 * render. Staff see their own rows only; the API enforces it too.
 */
export function AuditTab({
  initial,
  viewerIsAdmin,
}: Readonly<{ initial: OpsLogPage; viewerIsAdmin: boolean }>) {
  const [filters, setFilters] = useState<OpsLogFilters>({});
  const [page, setPage] = useState(1);
  // Blank filters leave the key, so a cleared filter is the seeded key again.
  const active = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v?.trim()),
  ) as OpsLogFilters;
  const pristine = page === 1 && Object.keys(active).length === 0;
  const { data } = useQuery({
    queryKey: ["money-audit", active, page],
    queryFn: () => fetchPage(active, page),
    initialData: pristine ? initial : undefined,
    initialDataUpdatedAt: pristine
      ? new Date(initial.fetchedAt).getTime()
      : undefined,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const lastPage = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  return (
    <Card className="m-4 md:m-6 lg:m-8">
      <CardHeader>
        <CardTitle className="text-lg">Audit log</CardTitle>
        {!viewerIsAdmin && (
          <p className="text-sm text-muted-foreground">
            You see the actions you took yourself.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {FILTERS.filter((f) => viewerIsAdmin || !f.adminOnly).map((f) => (
            <Input
              key={f.key}
              aria-label={f.label}
              placeholder={f.label}
              value={filters[f.key] ?? ""}
              onChange={(e) => {
                setPage(1);
                setFilters((all) => ({ ...all, [f.key]: e.target.value }));
              }}
            />
          ))}
        </div>
        <ResponsiveTable<OpsLogRow>
          columns={columns}
          rows={data?.rows ?? []}
          getRowId={(r) => r.id}
          empty={
            <p className="py-8 text-center text-sm text-muted-foreground">
              No actions match these filters.
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
  );
}
