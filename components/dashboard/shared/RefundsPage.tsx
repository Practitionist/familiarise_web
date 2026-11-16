"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingCell } from "@/components/dashboard/backoffice/BookingCell";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import Link from "next/link";
import { traceHref } from "@/lib/backoffice/entity-trace-types";
import {
  readListBody,
  refundListPageSchema,
  type RefundListItem,
} from "@/lib/backoffice/money-list-schemas";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { refundStatusBadge } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
// `formatCurrencyAmount`, not the old major-unit formatter (deleted in #1396):
// refunds carry paise. The old call had both halves wrong — a field the payload
// has never contained, passed to the rupees formatter — so it rendered ₹NaN
// rather than a number that was merely 100× too large.
import { formatCurrencyAmount } from "@/utils/formatting";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  gatewaySelect,
  keepPreviousPageOnly,
  PagedListFilterCard,
  statusSelect,
} from "./paged-list-filters";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  RotateCcw,
  RefreshCw,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const PAGE_SIZE = 20;

export interface RefundsPageProps {
  /** API endpoint to fetch refunds from */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
  /** React Query key prefix */
  queryKeyPrefix?: string;
  /** Operational panel rendered directly below DashboardHeader */
  beforeContent?: React.ReactNode;
}

export function RefundsPage({
  apiEndpoint = "/api/admin/refunds",
  title = "Refunds",
  description = "View and track refund requests",
  queryKeyPrefix = "refunds",
  beforeContent,
}: RefundsPageProps) {
  const { basePath } = useBackofficeCapability();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [gatewayFilter, setGatewayFilter] = useState("all");
  const [page, setPage] = useState(1);

  const queryKey = [
    queryKeyPrefix,
    page,
    searchQuery,
    statusFilter,
    gatewayFilter,
  ];
  const {
    data: refundsData,
    isLoading: loading,
    refetch: refetchRefunds,
    error: refundsError,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", String(PAGE_SIZE));
      if (searchQuery) params.set("search", searchQuery);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);
      const response = await fetch(`${apiEndpoint}?${params}`);
      return readListBody(
        response,
        refundListPageSchema,
        "Failed to fetch refunds",
      );
    },
    placeholderData: keepPreviousPageOnly(queryKey, 1),
  });

  // Show toast on error (React Query v5 removed onError callback)
  useEffect(() => {
    if (refundsError) {
      console.error("Error fetching refunds:", refundsError);
      toast({
        title: "Error",
        description: "Failed to load refunds",
        variant: "destructive",
      });
    }
  }, [refundsError, toast]);

  const refunds: RefundListItem[] = refundsData?.refunds ?? [];
  const total = refundsData?.total ?? 0;

  // #997 secondary findings — server-computed, dashboard-wide (previously
  // `.filter()` over the current page's ≤20 rows, which undercounted).
  const stats = {
    total,
    pending: refundsData?.stats?.pendingCount ?? 0,
    succeeded: refundsData?.stats?.succeededCount ?? 0,
    failed: refundsData?.stats?.failedCount ?? 0,
  };

  const renderRowActions = (refund: RefundListItem) =>
    refund.payment ? (
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" asChild>
          <Link href={traceHref(basePath, "payment", refund.payment.id)}>
            Trace
          </Link>
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a
            href={`${basePath}/payments/${refund.payment.id}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open the payment in a new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </span>
    ) : null;

  const columns: ResponsiveColumn<RefundListItem>[] = [
    {
      key: "buyer",
      header: "Buyer",
      primary: true,
      cell: (refund) => <PersonCell person={refund.payment?.buyer} />,
    },
    {
      key: "booking",
      header: "Booking",
      cell: (refund) => (
        <div className="min-w-0 space-y-1">
          <BookingCell booking={refund.payment?.booking} basePath={basePath} />
          <p
            className="truncate font-mono text-[11px] text-muted-foreground/70"
            title={refund.refundId}
          >
            {refund.refundId}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "font-medium",
      cell: (refund) =>
        formatCurrencyAmount(refund.amountPaise, refund.currency),
    },
    {
      key: "gateway",
      header: "Gateway",
      className: "text-sm text-muted-foreground",
      cell: (refund) => gatewayLabel(refund.paymentGateway),
    },
    {
      key: "status",
      header: "Status",
      cell: (refund) => <StatusBadge {...refundStatusBadge(refund.status)} />,
    },
    {
      key: "reason",
      header: "Reason",
      className: "text-sm text-muted-foreground max-w-[200px] truncate",
      cell: (refund) => refund.reason || "-",
    },
    {
      key: "date",
      header: "Date",
      className: "text-sm text-muted-foreground",
      cell: (refund) => <OperatorTime value={refund.createdAt} />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title={title}
        subtitle={description}
        actions={
          <Button
            variant="outline"
            onClick={() => refetchRefunds()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {beforeContent}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <RotateCcw className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-sm text-muted-foreground">Total Refunds</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pending}</p>
              <p className="text-sm text-muted-foreground">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.succeeded}</p>
              <p className="text-sm text-muted-foreground">Succeeded</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.failed}</p>
              <p className="text-sm text-muted-foreground">Failed</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <PagedListFilterCard
        search={{
          label: "Search refunds",
          placeholder: "Search by refund ID...",
          value: searchQuery,
          onChange: setSearchQuery,
        }}
        selects={[
          statusSelect(statusFilter, setStatusFilter, [
            { value: "PENDING", label: "Pending" },
            { value: "SUCCEEDED", label: "Succeeded" },
            { value: "FAILED", label: "Failed" },
            { value: "CANCELLED", label: "Cancelled" },
          ]),
          gatewaySelect(gatewayFilter, setGatewayFilter),
        ]}
        setPage={setPage}
      />

      {/* Refunds Table */}
      <Card>
        <CardContent className="p-0 sm:p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : (
            <ResponsiveTable<RefundListItem>
              columns={columns}
              rows={refunds}
              getRowId={(r) => r.id}
              rowActions={renderRowActions}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <RotateCcw className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No refunds found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
      />
    </div>
  );
}
