"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/dashboard/FilterBar";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
// Paise-aware and per-currency: the local helper this replaces divided by 100
// and rounded to whole rupees, so 12,345 paise printed as ₹123 rather than
// ₹123.45, and any currency with different minor-unit rules was wrong too.
import { formatCurrencyAmount } from "@/utils/formatting";
import { disputeStatusLabel } from "@/lib/labels/money-labels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertTriangle,
  RefreshCw,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  Eye,
} from "lucide-react";
import type { Dispute, DisputeListResponse } from "@/types/disputes";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "LOST":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "UNDER_REVIEW":
    case "WARNING_UNDER_REVIEW":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "CHARGE_REFUNDED":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "CLOSED":
    case "WARNING_CLOSED":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
    case "CHARGE_REFUNDED":
      return <CheckCircle className="h-3 w-3" />;
    case "LOST":
      return <XCircle className="h-3 w-3" />;
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return <AlertTriangle className="h-3 w-3" />;
    case "UNDER_REVIEW":
    case "WARNING_UNDER_REVIEW":
      return <Clock className="h-3 w-3" />;
    case "CLOSED":
    case "WARNING_CLOSED":
      return <AlertCircle className="h-3 w-3" />;
    default:
      return null;
  }
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

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
      <div className="flex items-center gap-1.5">
        <span>{formatDate(dueBy)}</span>
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

const DISPUTE_COLUMNS: ResponsiveColumn<Dispute>[] = [
  {
    key: "disputeId",
    header: "Dispute ID",
    primary: true,
    cell: (dispute) => (
      <div>
        <p className="font-mono text-sm">
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
          <p className="text-xs text-muted-foreground/70">
            Payment: {dispute.payment.paymentIntent.slice(-12)}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    className: "font-medium",
    cell: (dispute) =>
      formatCurrencyAmount(dispute.amountPaise, dispute.currency),
  },
  {
    key: "gateway",
    header: "Gateway",
    className: "text-sm text-muted-foreground",
    cell: (dispute) => gatewayLabel(dispute.paymentGateway),
  },
  {
    key: "status",
    header: "Status",
    cell: (dispute) => (
      <Badge
        className={`${getStatusColor(dispute.status)} gap-1`}
        variant="secondary"
      >
        {getStatusIcon(dispute.status)}
        {disputeStatusLabel(dispute.status)}
      </Badge>
    ),
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
    cell: (dispute) => formatDate(dispute.createdAt),
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
  const { basePath } = useBackofficeCapability();
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
    queryFn: async (): Promise<DisputeListResponse> => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (searchQuery) params.set("search", searchQuery);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);

      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch disputes");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });

  const disputes = data?.disputes ?? [];
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;
  const urgentCount = data?.urgentDisputes ?? 0;
  const underReviewCount = data?.stats?.underReviewCount ?? 0;
  const wonCount = data?.stats?.wonCount ?? 0;

  const handleViewDispute = (disputeId: string) => {
    router.push(`${basePath}/disputes/${disputeId}`);
  };

  const renderRowActions = (dispute: Dispute) => (
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
            days). Please escalate to admin for evidence submission.
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
              <p className="text-2xl font-bold">{total}</p>
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
              <p className="text-2xl font-bold text-red-600">{urgentCount}</p>
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
              <p className="text-2xl font-bold">{underReviewCount}</p>
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
              <p className="text-2xl font-bold">{wonCount}</p>
              <p className="text-sm text-muted-foreground">Won</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <FilterBar
            search={{
              label: "Search disputes",
              placeholder: "Search by dispute ID...",
              value: searchQuery,
              onChange: (value) => {
                setSearchQuery(value);
                setPage(1);
              },
            }}
            selects={[
              {
                key: "status",
                label: "Status",
                value: statusFilter,
                options: [
                  { value: "all", label: "All Status" },
                  { value: "NEEDS_RESPONSE", label: "Needs Response" },
                  {
                    value: "WARNING_NEEDS_RESPONSE",
                    label: "Warning - Needs Response",
                  },
                  { value: "UNDER_REVIEW", label: "Under Review" },
                  {
                    value: "WARNING_UNDER_REVIEW",
                    label: "Warning - Under Review",
                  },
                  { value: "CHARGE_REFUNDED", label: "Charge Refunded" },
                  { value: "WON", label: "Won" },
                  { value: "LOST", label: "Lost" },
                  { value: "CLOSED", label: "Closed" },
                  { value: "WARNING_CLOSED", label: "Warning - Closed" },
                ],
                onChange: (v) => {
                  setStatusFilter(v);
                  setPage(1);
                },
              },
              {
                key: "gateway",
                label: "Gateway",
                value: gatewayFilter,
                options: [
                  { value: "all", label: "All Gateways" },
                  { value: "STRIPE", label: "Stripe" },
                  { value: "RAZORPAY", label: "Razorpay" },
                ],
                onChange: (v) => {
                  setGatewayFilter(v);
                  setPage(1);
                },
              },
            ]}
            canClear={
              Boolean(searchQuery) ||
              statusFilter !== "all" ||
              gatewayFilter !== "all"
            }
            onClear={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setGatewayFilter("all");
              setPage(1);
            }}
          />
        </CardContent>
      </Card>

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
            <ResponsiveTable<Dispute>
              columns={DISPUTE_COLUMNS}
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
