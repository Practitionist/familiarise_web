"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { FilterBar } from "@/components/dashboard/FilterBar";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import {
  payoutListPageSchema,
  readListBody,
  type PayoutListItem,
} from "@/lib/backoffice/money-list-schemas";
import { istDateKey } from "@/lib/compliance/ist-period";
import { escapeCsvField } from "@/lib/csv/keyset-export";
import { gatewayLabel, payoutMethodLabel } from "@/lib/labels/money-labels";
import { payoutStatusBadge } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { formatCurrencyAmount } from "@/utils/formatting";

type Payout = PayoutListItem;

const PAGE_SIZE = 20;

async function fetchPayouts(
  statuses: readonly string[],
  page: number,
  search: string,
) {
  const params = new URLSearchParams({
    statusIn: statuses.join(","),
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (search) params.set("search", search);
  const res = await fetch(`/api/admin/payouts?${params}`);
  return readListBody(res, payoutListPageSchema, "Failed to fetch payouts");
}

const columns: ResponsiveColumn<Payout>[] = [
  {
    key: "consultant",
    header: "Expert",
    primary: true,
    cell: (p) => (
      <PersonCell
        person={{
          id: p.consultantUserId,
          name: p.consultantName,
          email: p.consultantEmail,
        }}
      />
    ),
  },
  {
    key: "payoutId",
    header: "Payout ID",
    cell: (p) => (
      <span
        data-copyable=""
        className="font-mono text-xs text-muted-foreground"
        title={p.id}
      >
        {p.id.slice(-8).toUpperCase()}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    cell: (p) => (
      <span className="text-sm font-semibold tabular-nums">
        {formatCurrencyAmount(p.amount, p.currency)}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (p) => <StatusBadge {...payoutStatusBadge(p.status)} />,
  },
  {
    key: "method",
    header: "Method",
    cell: (p) => `${payoutMethodLabel(p.method)} · ${gatewayLabel(p.provider)}`,
  },
  {
    key: "updated",
    header: "Approved / processed",
    cell: (p) => (
      <OperatorTime
        value={p.processedAt ?? p.approvedAt}
        className="text-sm text-muted-foreground"
      />
    ),
  },
  {
    key: "failure",
    header: "Why",
    cell: (p) => (
      <span className="text-sm text-muted-foreground">
        {p.failureReason ?? "—"}
      </span>
    ),
  },
];

/** The CSV a page exports, named by the IST date it was taken on. */
export function payoutCsvFilename(name: string, now: Date): string {
  return `payouts-${name}-${istDateKey(now)}.csv`;
}

// #1527 review — consultantName/consultantEmail are user-controlled; escape
// every cell (RFC 4180 quoting + formula-trigger neutralizing) rather than a
// bare join, matching the statutory exporters' rule (lib/csv/keyset-export.ts).
function exportCsv(rows: Payout[], name: string) {
  const header = ["ID", "Consultant", "Email", "Amount", "Currency", "Status"];
  const lines = rows.map((p) =>
    [
      p.id,
      p.consultantName,
      p.consultantEmail ?? "",
      (p.amount / 100).toFixed(2),
      p.currency,
      p.status,
    ]
      .map(escapeCsvField)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = payoutCsvFilename(name, new Date());
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * #1527 — one payout list per board tab, keyed by the statuses it covers, so
 * every PayoutStatus lands on a tab (APPROVED, FAILED, CANCELLED and REVERSED
 * used to show nowhere). Search and a true total, paged server-side.
 */
export function PayoutListSection({
  statuses,
  name,
  empty,
  note,
}: Readonly<{
  statuses: readonly string[];
  /** Short slug for the CSV file and the query key. */
  name: string;
  empty: string;
  note?: string;
}>) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-payouts", name, page, search],
    queryFn: () => fetchPayouts(statuses, page, search),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // Payout state is money-facing: refresh when the operator comes back.
    refetchOnWindowFocus: true,
  });
  const rows = data?.payouts ?? [];

  return (
    <div className="space-y-4">
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
      <ResponsiveTable<Payout>
        columns={columns}
        rows={rows}
        getRowId={(p) => p.id}
        isLoading={isLoading && !data}
        error={error && !data ? error : undefined}
        onRetry={() => void refetch()}
        toolbar={
          <FilterBar
            search={{
              label: "Search payouts",
              placeholder: "Expert name or email",
              value: search,
              onChange: (v) => {
                setSearch(v);
                setPage(1);
              },
            }}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => exportCsv(rows, name)}
            >
              <Download className="mr-2 h-4 w-4" />
              Export this page
            </Button>
          </FilterBar>
        }
        empty={
          <p className="py-10 text-center text-sm text-muted-foreground">
            {search ? "No payouts match your search." : empty}
          </p>
        }
      />
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={data?.pagination.total ?? 0}
        onPageChange={setPage}
      />
    </div>
  );
}
