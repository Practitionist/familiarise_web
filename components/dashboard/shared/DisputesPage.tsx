"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingCell } from "@/components/dashboard/backoffice/BookingCell";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import {
  disputeListPageSchema,
  readListBody,
  type DisputeListItem,
} from "@/lib/backoffice/money-list-schemas";
import { disputeStatus } from "@/lib/labels/backoffice-labels";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { OperatorTimeStack } from "@/lib/time/operator-time";
import { useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  gatewaySelect,
  PagedListFilterCard,
  statusSelect,
} from "./paged-list-filters";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
// Paise-aware and per-currency: the local helper this replaces divided by 100
// and rounded to whole rupees, so 12,345 paise printed as ₹123 rather than
// ₹123.45, and any currency with different minor-unit rules was wrong too.
import { formatCurrencyAmount } from "@/utils/formatting";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertTriangle,
  RefreshCw,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  Eye,
} from "lucide-react";

const PAGE_SIZE = 20;

const getDaysUntilDue = (dueBy: string | null) => {
  if (!dueBy) return null;
  const now = new Date();
  const due = new Date(dueBy);
  const diffDays = Math.ceil(
    (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );
  return diffDays;
};

function getDueCellClassName(isOverdue: boolean, isUrgent: boolean): string {
  if (isOverdue) return "text-red-600 font-semibold";
  if (isUrgent) return "text-red-600 font-medium";
  return "text-muted-foreground";
}

function DisputeDueCell({
  dueBy,
  status,
}: Readonly<{ dueBy: string | null; status: string }>) {
  if (!dueBy) return <>-</>;
  const daysUntilDue = getDaysUntilDue(dueBy);
  const hoursUntilDue =
    (new Date(dueBy).getTime() - Date.now()) / (1000 * 60 * 60);
  const isActionable =
    status === "NEEDS_RESPONSE" || status === "WARNING_NEEDS_RESPONSE";
  const isOverdue = isActionable && new Date(dueBy).getTime() < Date.now();
  const isCritical48h = !isOverdue && hoursUntilDue <= 48 && hoursUntilDue >= 0;
  const isUrgent =
    isOverdue ||
    isCritical48h ||
    (daysUntilDue !== null && daysUntilDue <= 3 && daysUntilDue >= 0);

  return (
    <div className={getDueCellClassName(isOverdue, isUrgent)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <OperatorTimeStack value={dueBy} />
        {isOverdue && (
          <Badge variant="destructive" className="text-[10px]">
            Overdue
          </Badge>
        )}
        {!isOverdue && isCritical48h && (
          <Badge variant="destructive" className="text-[10px]">
            Due &lt; 48h
          </Badge>
        )}
      </div>
      {isOverdue && (
        <p className="text-xs font-semibold text-red-600">
          {`Overdue by ${Math.max(1, Math.abs(daysUntilDue ?? 1))} day(s)`}
        </p>
      )}
      {!isOverdue && daysUntilDue !== null && daysUntilDue >= 0 && (
        <p className="text-xs">
          {daysUntilDue === 0 ? "Due today!" : `${daysUntilDue} days left`}
        </p>
      )}
    </div>
  );
}

const disputeColumns = (
  basePath: string,
): ResponsiveColumn<DisputeListItem>[] => [
  {
    key: "buyer",
    header: "Buyer",
    primary: true,
    className: "max-w-[12rem]",
    cell: (dispute) => <PersonCell person={dispute.payment?.buyer} />,
  },
  {
    // The booking over the dispute's own ids, so the table fits its card.
    key: "booking",
    header: "Booking and dispute",
    className: "max-w-[14rem]",
    cell: (dispute) => (
      <div className="min-w-0 space-y-1">
        <BookingCell booking={dispute.payment?.booking} basePath={basePath} />
        <p className="break-all font-mono text-xs">
          {dispute.disputeId?.slice(-12) || dispute.id.slice(-8).toUpperCase()}
        </p>
        <p className="text-xs text-muted-foreground/70">
          Internal:{" "}
          <button
            type="button"
            data-copyable=""
            className="select-text font-mono hover:underline"
            title={dispute.id}
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard?.writeText(dispute.id);
            }}
          >
            {dispute.id.slice(-8).toUpperCase()}
          </button>
        </p>
        {dispute.payment && (
          <p className="break-all text-xs text-muted-foreground/70">
            Payment: {dispute.payment.paymentIntent.slice(-12)}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    className: "whitespace-nowrap",
    cell: (dispute) => (
      <div>
        <p className="font-medium">
          {formatCurrencyAmount(dispute.amountPaise, dispute.currency)}
        </p>
        <p className="text-xs text-muted-foreground">
          {gatewayLabel(dispute.paymentGateway)}
        </p>
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (dispute) => <StatusBadge {...disputeStatus(dispute.status)} />,
  },
  {
    key: "dueBy",
    header: "Evidence Due By",
    cell: (dispute) => (
      <DisputeDueCell dueBy={dispute.dueBy} status={dispute.status} />
    ),
  },
  {
    key: "created",
    header: "Created",
    className: "text-sm text-muted-foreground",
    cell: (dispute) => <OperatorTimeStack value={dispute.createdAt} />,
  },
];

export interface DisputesPageProps {
  /** API endpoint for fetching disputes */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
}

export function DisputesPage({
  apiEndpoint = "/api/admin/disputes",
  title = "Disputes",
  description = "View and track payment disputes",
}: DisputesPageProps) {
  const { basePath, can } = useBackofficeCapability();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [gatewayFilter, setGatewayFilter] = useState("all");
  const [page, setPage] = useState(1);
  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: [
      "admin-disputes",
      apiEndpoint,
      page,
      searchQuery,
      statusFilter,
      gatewayFilter,
    ],
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
        disputeListPageSchema,
        "Failed to fetch disputes",
      );
    },
    placeholderData: keepPreviousData,
  });
  // A failed first read has no counts to show; never print its empty fallback as zero.
  const shown = (count: number) => (isError && !data ? "—" : count);

  const columns = useMemo(() => disputeColumns(basePath), [basePath]);
  const disputes = data?.disputes ?? [];
  const total = data?.total ?? 0;
  const urgentCount = data?.urgentDisputes ?? 0;
  const underReviewCount = data?.stats?.underReviewCount ?? 0;
  const wonCount = data?.stats?.wonCount ?? 0;

  const handleViewDispute = (disputeId: string) => {
    router.push(`${basePath}/disputes/${disputeId}`);
  };

  const renderRowActions = (dispute: DisputeListItem) => (
    <Button asChild variant="ghost" size="icon" className="h-8 w-8">
      <Link
        href={`${basePath}/disputes/${dispute.id}`}
        onClick={(e) => {
          e.stopPropagation();
        }}
        aria-label="View dispute"
      >
        <Eye className="h-4 w-4" />
      </Link>
    </Button>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title={title}
        subtitle={description}
        actions={
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Urgent Disputes Alert */}
      {urgentCount > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Urgent Attention Required</AlertTitle>
          <AlertDescription>
            {urgentCount} dispute{urgentCount > 1 ? "s are" : " is"} overdue or
            require{urgentCount === 1 ? "s" : ""} an imminent response (&lt;= 3
            days).{" "}
            {can("disputes.manage")
              ? "Submit evidence before the deadline."
              : "Please escalate to an admin for evidence submission."}
          </AlertDescription>
        </Alert>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <AlertTriangle className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{shown(total)}</p>
              <p className="text-sm text-muted-foreground">Total Disputes</p>
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            urgentCount > 0 ? "border-red-200 bg-red-50 dark:bg-red-950/20" : ""
          }
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900">
              <AlertCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600">
                {shown(urgentCount)}
              </p>
              <p className="text-sm text-muted-foreground">
                Urgent / Overdue (Actionable)
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{shown(underReviewCount)}</p>
              <p className="text-sm text-muted-foreground">Under Review</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{shown(wonCount)}</p>
              <p className="text-sm text-muted-foreground">Won</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <PagedListFilterCard
        search={{
          label: "Search disputes",
          placeholder: "Search by dispute ID...",
          value: searchQuery,
          onChange: setSearchQuery,
        }}
        selects={[
          statusSelect(statusFilter, setStatusFilter, [
            { value: "NEEDS_RESPONSE", label: "Needs Response" },
            {
              value: "WARNING_NEEDS_RESPONSE",
              label: "Warning - Needs Response",
            },
            { value: "UNDER_REVIEW", label: "Under Review" },
            { value: "WARNING_UNDER_REVIEW", label: "Warning - Under Review" },
            { value: "CHARGE_REFUNDED", label: "Charge Refunded" },
            { value: "WON", label: "Won" },
            { value: "LOST", label: "Lost" },
            { value: "CLOSED", label: "Closed" },
            { value: "WARNING_CLOSED", label: "Warning - Closed" },
          ]),
          gatewaySelect(gatewayFilter, setGatewayFilter),
        ]}
        setPage={setPage}
      />

      {/* Disputes Table */}
      <Card>
        <CardContent className="p-0 sm:p-6">
          {isError && !data && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load disputes.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          )}
          {(!isError || Boolean(data)) && isPending && (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          )}
          {(!isError || Boolean(data)) && !isPending && (
            <ResponsiveTable<DisputeListItem>
              columns={columns}
              rows={disputes}
              getRowId={(d) => d.id}
              onRowClick={(d) => handleViewDispute(d.id)}
              rowActions={renderRowActions}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <AlertTriangle className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No disputes found</p>
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
