"use client";

import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { formatRupees } from "@/lib/backoffice/rupees";
import type { MoneyDrillWire } from "@/schemas/money-overview";

/**
 * The rows behind a number. Every metric on the page opens one of these, so
 * a figure is never just a figure: it is a figure plus the rows that made
 * it, read with the same `where` the metric used.
 */
export function MoneyOverviewDrill({
  drill,
  onClose,
}: Readonly<{
  drill: MoneyDrillWire;
  onClose: () => void;
}>) {
  const columns: ResponsiveColumn<MoneyDrillWire["rows"][number]>[] = [
    {
      key: "label",
      header: "Row",
      primary: true,
      cell: (row) => (
        <span className="min-w-0 break-words font-medium text-foreground">
          {row.label}
        </span>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      cell: (row) => (
        <span className="text-muted-foreground">{row.detail}</span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "text-right",
      cell: (row) =>
        row.amountPaise === null ? (
          "—"
        ) : (
          <span className="tabular-nums">{formatRupees(row.amountPaise)}</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) =>
        row.status ? (
          <StatusBadge label={row.status} tone="neutral" size="sm" />
        ) : (
          "—"
        ),
    },
    {
      key: "at",
      header: "When",
      cell: (row) =>
        row.at ? new Date(row.at).toLocaleString("en-IN") : "—",
    },
  ];

  return (
    <Section
      variant="card"
      title={drill.title}
      description={drill.description}
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ResponsiveTable
        columns={columns}
        rows={drill.rows}
        getRowId={(row) => row.id}
        empty={
          <div className="py-8 text-center text-sm text-muted-foreground">
            No rows behind this number.
          </div>
        }
      />
      {drill.truncated && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the first 50 rows.
        </p>
      )}
    </Section>
  );
}
