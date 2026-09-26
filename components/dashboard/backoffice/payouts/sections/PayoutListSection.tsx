"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { gatewayLabel, payoutMethodLabel } from "@/lib/labels/money-labels";
import { payoutStatusBadge } from "@/lib/labels/session-labels";
import type { Payout } from "@/types/payouts";
import { formatCurrencyAmount } from "@/utils/formatting";

interface PayoutListResponse {
  payouts: Payout[];
  pagination: { total: number; limit: number; offset: number };
}

const PAGE_SIZE = 20;

async function fetchPayouts(
  statuses: readonly string[],
  page: number,
  search: string,
): Promise<PayoutListResponse> {
  const params = new URLSearchParams({
    statusIn: statuses.join(","),
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (search) params.set("search", search);
  const res = await fetch(`/api/admin/payouts?${params}`);
  if (!res.ok) throw new Error("Failed to fetch payouts");
  return res.json() as Promise<PayoutListResponse>;
}

const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString() : "—";

const columns: ResponsiveColumn<Payout>[] = [
  {
    key: "consultant",
    header: "Consultant",
    primary: true,
    cell: (p) => (
      <div>
        <p className="text-sm font-medium text-foreground">
          {p.consultantName}
        </p>
        <p className="text-xs text-muted-foreground">{p.consultantEmail}</p>
      </div>
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
      <span className="text-sm text-muted-foreground">
        {when(p.processedAt ?? p.approvedAt)}
      </span>
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

function exportCsv(rows: Payout[], name: string) {
  const header = ["ID", "Consultant", "Email", "Amount", "Currency", "Status"];
  const lines = rows.map((p) =>
    [
      p.id,
      p.consultantName,
      p.consultantEmail,
      (p.amount / 100).toFixed(2),
      p.currency,
      p.status,
    ].join(","),
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], {
    type: "text/csv",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `payouts-${name}-${new Date().toISOString().split("T")[0]}.csv`;
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
              placeholder: "Consultant name or email",
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
              Export CSV
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
