"use client";

import { useBackofficeCapability } from "@/components/dashboard/backoffice/BackofficeCapabilityProvider";
import { BookingCell } from "@/components/dashboard/backoffice/BookingCell";
import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { traceHref } from "@/lib/backoffice/entity-trace-types";
import {
  paymentListPageSchema,
  readListBody,
  type PaymentListItem,
} from "@/lib/backoffice/money-list-schemas";
import { gatewayLabel } from "@/lib/labels/money-labels";
import { paymentStatusBadge } from "@/lib/labels/session-labels";
import { OperatorTimeStack } from "@/lib/time/operator-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { keepPreviousPageOnly } from "./paged-list-filters";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import {
  PaymentGateway,
  PaymentStatus,
  AppointmentsType,
} from "@prisma/client";
import { formatCurrencyAmount } from "@/utils/formatting";

// Fetch payments with filters
async function fetchPayments(params: {
  page: number;
  limit: number;
  status?: PaymentStatus;
  gateway?: PaymentGateway;
  appointmentType?: AppointmentsType;
  search?: string;
}) {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.appointmentType && { appointmentType: params.appointmentType }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/payments?${searchParams}`);
  return readListBody(
    response,
    paymentListPageSchema,
    "Failed to fetch payments",
  );
}

/**
 * #1365 — the B2C tax invoice for a payment. Defined at module scope, not
 * inside the page, so it is never re-created on a render (S6478). An empty
 * cell means the payment was org-funded and is invoiced to the organization
 * instead, which is the correct answer rather than a gap to chase.
 */
function renderInvoiceCell(payment: PaymentListItem) {
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

const PAGE_SIZE = 20;

export function PaymentsPage({
  initialStatus,
}: Readonly<{ initialStatus?: PaymentStatus }> = {}) {
  // #1527 — a staff-tree row must link inside the staff tree.
  const { basePath } = useBackofficeCapability();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | undefined>(
    initialStatus,
  );
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [appointmentType, setAppointmentType] = useState<
    AppointmentsType | undefined
  >();
  const [search, setSearch] = useState("");
  const limit = PAGE_SIZE;

  const queryKey = [
    "operator-payments",
    page,
    status,
    gateway,
    appointmentType,
    search,
  ];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      fetchPayments({ page, limit, status, gateway, appointmentType, search }),
    staleTime: 30 * 1000,
    placeholderData: keepPreviousPageOnly(queryKey, 1),
  });

  const handleFilterChange = () => {
    setPage(1); // Reset to first page when filters change
  };

  const columns: ResponsiveColumn<PaymentListItem>[] = [
    {
      key: "buyer",
      header: "Buyer",
      primary: true,
      className: "max-w-[12rem]",
      cell: (payment) => <PersonCell person={payment.buyer} />,
    },
    {
      key: "booking",
      header: "Booking",
      className: "max-w-[14rem]",
      cell: (payment) => (
        <div className="min-w-0 space-y-1">
          <BookingCell booking={payment.booking} basePath={basePath} />
          <p
            className="break-all font-mono text-[11px] text-muted-foreground/70"
            title={payment.paymentIntent}
          >
            {payment.paymentIntent}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "whitespace-nowrap",
      cell: (payment) => (
        <div>
          <p className="text-sm text-foreground">
            {formatCurrencyAmount(payment.amount, payment.currency)}
          </p>
          <p className="text-xs text-muted-foreground">
            {gatewayLabel(payment.paymentGateway)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (payment) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge {...paymentStatusBadge(payment.paymentStatus)} />
          {payment.isMockPayment && (
            <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
              Mock
            </span>
          )}
        </div>
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
      className: "text-sm",
      cell: (payment) => <OperatorTimeStack value={payment.createdAt} />,
    },
  ];

  const renderRowActions = (payment: PaymentListItem) => (
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
                  setStatus(z.nativeEnum(PaymentStatus).safeParse(value).data);
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
                    z.nativeEnum(PaymentGateway).safeParse(value).data,
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
                    z.nativeEnum(AppointmentsType).safeParse(value).data,
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
              <ResponsiveTable<PaymentListItem>
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

              <TablePagination
                className="pt-4"
                page={page}
                pageSize={limit}
                total={data.total}
                onPageChange={setPage}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
