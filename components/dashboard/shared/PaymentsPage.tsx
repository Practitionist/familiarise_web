"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { traceHref } from "@/lib/backoffice/entity-trace-types";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  PaymentGateway,
  PaymentStatus,
  AppointmentsType,
} from "@prisma/client";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { PaymentListResponse, Payment } from "@/types/payments";

// Fetch payments with filters
async function fetchPayments(params: {
  page: number;
  limit: number;
  status?: PaymentStatus;
  gateway?: PaymentGateway;
  appointmentType?: AppointmentsType;
  search?: string;
}): Promise<PaymentListResponse> {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.appointmentType && { appointmentType: params.appointmentType }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/payments?${searchParams}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payments");
  }
  return response.json() as Promise<PaymentListResponse>;
}

/**
 * #1365 — the B2C tax invoice for a payment. Defined at module scope, not
 * inside the page, so it is never re-created on a render (S6478). An empty
 * cell means the payment was org-funded and is invoiced to the organization
 * instead, which is the correct answer rather than a gap to chase.
 */
function renderInvoiceCell(payment: Payment) {
  if (!payment.consumerInvoice) {
    return <span className="text-muted-foreground/70">—</span>;
  }
  return (
    <a
      href={`/api/payments/${payment.id}/invoice/pdf`}
      className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
    >
      {payment.consumerInvoice.invoiceNumber}
    </a>
  );
}

export function PaymentsPage() {
  // #1527 — a staff-tree row must link inside the staff tree.
  const { basePath } = useBackofficeCapability();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | undefined>();
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [appointmentType, setAppointmentType] = useState<
    AppointmentsType | undefined
  >();
  const [search, setSearch] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "operator-payments",
      page,
      status,
      gateway,
      appointmentType,
      search,
    ],
    queryFn: () =>
      fetchPayments({ page, limit, status, gateway, appointmentType, search }),
    staleTime: 30 * 1000, // 30 seconds
  });

  const handleFilterChange = () => {
    setPage(1); // Reset to first page when filters change
  };

  const columns: ResponsiveColumn<Payment>[] = [
    {
      key: "paymentId",
      header: "Payment ID",
      primary: true,
      cell: (payment) => (
        <span className="font-mono text-sm text-foreground">
          {payment.paymentIntent?.substring(0, 20)}...
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {formatCurrencyAmount(payment.amount, payment.currency)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (payment) => (
        <span
          className={`px-2 py-1 rounded text-xs font-medium ${
            payment.paymentStatus === "SUCCEEDED"
              ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
              : payment.paymentStatus === "PENDING"
                ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400"
                : payment.paymentStatus === "EXPIRED"
                  ? "bg-muted text-muted-foreground"
                  : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
          }`}
        >
          {paymentStatusBadge(payment.paymentStatus).label}
        </span>
      ),
    },
    {
      key: "gateway",
      header: "Gateway",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {gatewayLabel(payment.paymentGateway)}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {payment.appointment?.appointmentType || "N/A"}
        </span>
      ),
    },
    {
      key: "mock",
      header: "Mock",
      cell: (payment) =>
        payment.isMockPayment ? (
          <span className="px-2 py-1 rounded text-xs font-medium bg-muted text-foreground">
            MOCK
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        ),
    },
    {
      key: "invoice",
      header: "Invoice",
      cell: renderInvoiceCell,
    },
    {
      key: "date",
      header: "Date",
      cell: (payment) => (
        <span className="text-sm text-muted-foreground">
          {new Date(payment.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  const renderRowActions = (payment: Payment) => (
    <span className="flex gap-3">
      <Link
        href={`${basePath}/payments/${payment.id}`}
        className="font-medium text-foreground hover:text-muted-foreground"
      >
        View
      </Link>
      <Link
        href={traceHref(basePath, "payment", payment.id)}
        className="font-medium text-foreground hover:text-muted-foreground"
      >
        Trace
      </Link>
    </span>
  );

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600 dark:text-red-400">
              Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              {error instanceof Error
                ? error.message
                : "Failed to load payments"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payments"
        subtitle="Manage and view all platform payments"
      />

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <FilterBar
            search={{
              label: "Search payments",
              placeholder: "Search payment ID...",
              value: search,
              onChange: (value) => {
                setSearch(value);
                handleFilterChange();
              },
            }}
            selects={[
              {
                key: "status",
                label: "Status",
                value: status ?? "all",
                options: [
                  { value: "all", label: "All Statuses" },
                  { value: "PENDING", label: "Pending" },
                  { value: "SUCCEEDED", label: "Succeeded" },
                  { value: "FAILED", label: "Failed" },
                  { value: "EXPIRED", label: "Expired" },
                ],
                onChange: (value) => {
                  setStatus(
                    value === "all" ? undefined : (value as PaymentStatus),
                  );
                  handleFilterChange();
                },
              },
              {
                key: "gateway",
                label: "Gateway",
                value: gateway ?? "all",
                options: [
                  { value: "all", label: "All Gateways" },
                  { value: "STRIPE", label: "Stripe" },
                  { value: "RAZORPAY", label: "Razorpay" },
                ],
                onChange: (value) => {
                  setGateway(
                    value === "all" ? undefined : (value as PaymentGateway),
                  );
                  handleFilterChange();
                },
              },
              {
                key: "type",
                label: "Type",
                value: appointmentType ?? "all",
                options: [
                  { value: "all", label: "All Types" },
                  { value: "CONSULTATION", label: "Consultation" },
                  { value: "SUBSCRIPTION", label: "Subscription" },
                  { value: "WEBINAR", label: "Webinar" },
                  { value: "CLASS", label: "Class" },
                ],
                onChange: (value) => {
                  setAppointmentType(
                    value === "all" ? undefined : (value as AppointmentsType),
                  );
                  handleFilterChange();
                },
              },
            ]}
            canClear={Boolean(search || status || gateway || appointmentType)}
            onClear={() => {
              setStatus(undefined);
              setGateway(undefined);
              setAppointmentType(undefined);
              setSearch("");
              setPage(1);
            }}
          />
        </CardContent>
      </Card>

      {/* Payments Table */}
      <Card>
        <CardContent className="pt-6">
          {isLoading || !data ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <ResponsiveTable<Payment>
                columns={columns}
                rows={data.payments}
                getRowId={(p) => p.id}
                rowActions={renderRowActions}
                empty={
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">No payments found</p>
                  </div>
                }
              />

              {/* Pagination */}
              {data.payments.length > 0 && (
                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, data.total)} of {data.total}{" "}
                    payments
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page * limit >= data.total}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
