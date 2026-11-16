"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";

import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { TablePagination } from "@/components/dashboard/TablePagination";
import type { OpsLogPage } from "@/lib/backoffice/ops-log-types";
import {
  readListBody,
  targetRefSchema,
} from "@/lib/backoffice/money-list-schemas";
import { OpsLogFiltersSchema, type OpsLogFilters } from "@/schemas/ops-log";
import { enumLabel } from "@/lib/labels/money-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { TargetCell } from "./TargetCell";

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
  { key: "since", label: "Since (YYYY-MM-DD, IST day start, or ISO time)" },
];

// Entries sorted by key, so the comparison ignores the order filters were set in.
const filterKey = (filters: OpsLogFilters) =>
  JSON.stringify(
    Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
  );
const sameFilters = (a: OpsLogFilters, b: OpsLogFilters) =>
  filterKey(a) === filterKey(b);

/** The audit route's body; a malformed one takes the error path. */
export const opsLogPageSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      actorUserId: z.string().nullable(),
      actorName: z.string().nullable(),
      actorRole: z.string(),
      surface: z.string(),
      action: z.string(),
      targetKind: z.string(),
      targetId: z.string(),
      target: targetRefSchema.nullable(),
      reason: z.string(),
      before: z.unknown(),
      after: z.unknown(),
    }),
  ),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  fetchedAt: z.string(),
});
type AuditRow = z.infer<typeof opsLogPageSchema>["rows"][number];

async function fetchPage(filters: OpsLogFilters, page: number) {
  const params = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const res = await fetch(`/api/admin/ops-actions?${params}`);
  return readListBody(res, opsLogPageSchema, "Failed to load the audit log");
}

const auditColumns = (basePath: string): ResponsiveColumn<AuditRow>[] => [
  {
    key: "when",
    header: "When",
    primary: true,
    cell: (r) => <OperatorTime value={r.createdAt} />,
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
    cell: (r) => (
      <TargetCell
        kind={r.targetKind}
        id={r.targetId}
        target={r.target}
        basePath={basePath}
      />
    ),
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
  const { role, basePath } = useBackofficeCapability();
  const viewerIsAdmin = role === "ADMIN";
  const columns = useMemo(() => auditColumns(basePath), [basePath]);
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
              Enter Since as a date (YYYY-MM-DD, from the start of that IST day)
              or an ISO time.
            </p>
          ) : null}
          <ResponsiveTable<AuditRow>
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
          <TablePagination
            page={page}
            pageSize={data?.pageSize ?? 50}
            total={sinceInvalid ? 0 : (data?.total ?? 0)}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
