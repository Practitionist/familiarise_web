"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { Stat, StatRow } from "@/components/dashboard/Stat";
import { Section } from "@/components/dashboard/Section";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useListParams } from "@/hooks/useListParams";
import { useCurrency } from "@/hooks/useCurrency";
import { creditSourceLabel } from "@/lib/labels/credit-source";
import type {
  ConsulteeCreditRow,
  ConsulteeCreditUsageRow,
  ConsulteePaymentsPayload,
} from "@/lib/data/consultee-payments";
import { NeedsYouBand } from "./NeedsYouBand";
import {
  PAYMENT_FILTER_KEYS,
  consulteePaymentsKey,
  type PaymentFilterKey,
} from "./payments-query";
import { PaymentsHistoryList } from "./PaymentsHistoryList";

const STATUS_OPTIONS = [
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded" },
  { value: "failed", label: "Failed" },
];

const RANGE_OPTIONS = [
  { value: "all", label: "Any time" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "year", label: "This year" },
];

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const formatDate = (date: Date | string) => DATE.format(new Date(date));

async function fetchConsulteePayments(
  consulteeId: string,
  page: number,
  status: string | null,
  range: string | null,
): Promise<ConsulteePaymentsPayload> {
  const qs = new URLSearchParams({ page: String(page) });
  if (status) qs.set("status", status);
  if (range) qs.set("range", range);
  const res = await fetch(
    `/api/dashboard/consultee/${consulteeId}/payments?${qs.toString()}`,
  );
  if (!res.ok) throw new Error("Failed to fetch payments");
  const json = await res.json();
  return json.data;
}

// Credits are INR; the viewer's display currency applies, as before (#1527 kept it).
type FormatPrice = (paise: number) => string;

const creditColumns = (
  inr: FormatPrice,
): ResponsiveColumn<ConsulteeCreditRow>[] => [
  {
    key: "source",
    header: "Source",
    primary: true,
    cell: (credit) => (
      <span className="text-foreground">
        {creditSourceLabel(credit.source)}
      </span>
    ),
  },
  {
    key: "date",
    header: "Date",
    cell: (credit) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatDate(credit.createdAt)}
      </span>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    headClassName: "text-right",
    className: "text-right",
    cell: (credit) => (
      <span className="font-medium tabular-nums text-foreground">
        {inr(credit.amount)}
      </span>
    ),
  },
  {
    key: "remaining",
    header: "Remaining",
    headClassName: "text-right",
    className: "text-right",
    cell: (credit) => (
      <span className="font-medium tabular-nums text-foreground">
        {inr(credit.remainingAmount)}
      </span>
    ),
  },
  {
    key: "expires",
    header: "Expires",
    cell: (credit) => (
      <span className="text-muted-foreground">
        {credit.expiresAt ? formatDate(credit.expiresAt) : "No expiry"}
      </span>
    ),
  },
];

const creditUsageColumns = (
  inr: FormatPrice,
): ResponsiveColumn<ConsulteeCreditUsageRow>[] => [
  {
    key: "source",
    header: "Source",
    primary: true,
    cell: (usage) => (
      <span className="text-foreground">
        {creditSourceLabel(usage.credit.source)}
      </span>
    ),
  },
  {
    key: "date",
    header: "Date",
    cell: (usage) => (
      <span className="text-muted-foreground">
        {formatDate(usage.createdAt)}
      </span>
    ),
  },
  {
    key: "used",
    header: "Used",
    headClassName: "text-right",
    className: "text-right",
    cell: (usage) => (
      <span className="font-medium tabular-nums text-foreground">
        −{inr(usage.amount)}
      </span>
    ),
  },
];

/**
 * /payments — Needs you · History · Credits (#1527 §7.1), each a URL tab.
 * History pages and filters through the URL (`?page=&status=&range=`) with
 * no silent cap; each row opens its payment detail page.
 */
export function PaymentsTab({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const list = useListParams<PaymentFilterKey>({
    filterKeys: PAYMENT_FILTER_KEYS,
  });
  const status = list.filters.status;
  const range = list.filters.range;
  // Personal pin, matching the sibling Appointments page (ADR 19); the route
  // defaults personal without ?orgScope=. The RSC page seeds this exact key.
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: consulteePaymentsKey(consulteeId, list.page, status, range),
    queryFn: () =>
      fetchConsulteePayments(consulteeId, list.page, status, range),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
    // E2E-audit P1 fix — the global query client sets refetchOnMount /
    // refetchOnWindowFocus to false, so a purchase made elsewhere in the same
    // SPA session never appeared here until a full reload. Remounting this tab
    // must always revalidate; the SSR seed only covers the first paint.
    refetchOnMount: "always",
  });

  if (isLoading && !data) return <PageSkeleton />;

  if (!data) {
    return (
      <ErrorState
        title="Couldn't load your payments"
        error={error}
        // #1527 — retry is a refetch, never a page reload.
        onRetry={() => void refetch()}
      />
    );
  }

  const filtered = !!status || !!range;

  return (
    <DashboardErrorBoundary>
      <PageHeader
        title="Payments"
        description="What you owe, what you paid, and your credits"
      />
      <UrlTabs
        tabs={[
          {
            value: "needs-you",
            label: "Needs you",
            content: <NeedsYouBand consulteeId={consulteeId} />,
          },
          {
            value: "history",
            label: "History",
            content: (
              <div className="space-y-4">
                <FilterBar
                  chips={{
                    label: "Status",
                    options: STATUS_OPTIONS,
                    value: status,
                    onChange: (value) => list.setFilter("status", value),
                    clearable: true,
                  }}
                  selects={[
                    {
                      key: "range",
                      label: "Date",
                      value: range ?? "all",
                      options: RANGE_OPTIONS,
                      onChange: (value) =>
                        list.setFilter("range", value === "all" ? null : value),
                    },
                  ]}
                  canClear={filtered}
                  onClear={list.clear}
                />
                {error && (
                  <ErrorState
                    variant="inline"
                    title="Couldn't refresh your payments"
                    onRetry={() => void refetch()}
                  />
                )}
                <PaymentsHistoryList
                  payments={data.payments}
                  consulteeId={consulteeId}
                  emptyTitle={
                    filtered ? "Nothing under these filters" : "No payments yet"
                  }
                />
                {data.total > data.pageSize && (
                  <TablePagination
                    page={data.page}
                    pageSize={data.pageSize}
                    total={data.total}
                    onPageChange={list.setPage}
                  />
                )}
              </div>
            ),
          },
          {
            value: "credits",
            label: "Credits",
            content: <CreditsPanel data={data} />,
          },
        ]}
      />
    </DashboardErrorBoundary>
  );
}

function CreditsPanel({ data }: Readonly<{ data: ConsulteePaymentsPayload }>) {
  const { formatPrice: inr } = useCurrency();
  return (
    <div className="space-y-6">
      {/* Balances come from the uncapped aggregate, not the listed rows. */}
      <StatRow columns={3}>
        <Stat label="Earned" value={inr(data.creditSummary.total)} />
        <Stat label="Used" value={inr(data.creditSummary.used)} />
        <Stat
          label="Balance"
          value={inr(data.creditSummary.remaining)}
          hint="Applied at checkout"
        />
      </StatRow>
      {data.credits.length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No credits yet"
          description="Refer friends to earn credits you can use on future bookings."
        />
      ) : (
        <ResponsiveTable<ConsulteeCreditRow>
          columns={creditColumns(inr)}
          rows={data.credits}
          getRowId={(c) => c.id}
        />
      )}
      {data.creditUsages.length > 0 && (
        <Section title="Usage history">
          <ResponsiveTable<ConsulteeCreditUsageRow>
            columns={creditUsageColumns(inr)}
            rows={data.creditUsages}
            getRowId={(u) => u.id}
          />
        </Section>
      )}
    </div>
  );
}
