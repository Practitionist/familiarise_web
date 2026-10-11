"use client";

import { httpsHref } from "@/schemas/url";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileText,
  Download,
  Building2,
  Calendar,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrencyAmount } from "@/utils/formatting";

function StatCard({
  title,
  value,
  subtitle,
  loading,
}: Readonly<{
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: unknown;
  variant?: "default" | "success" | "warning" | "danger";
  loading?: boolean;
}>) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <>
            <div className="text-xl font-semibold tabular-nums">{value}</div>
            {subtitle && (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export interface InvoicesPageProps {
  title: string;
  subtitle?: string;
  description?: string;
  apiEndpoint: string;
  dashboardBasePath?: string;
  queryKeyPrefix: string;
}

interface InvoicePagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface OrgInvoiceItem {
  id: string;
  invoiceNumber: string;
  status: string;
  displayCurrency: string;
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  hsnCode: string;
  issuedAt: string | null;
  dueDate: string;
  paidAt: string | null;
  pdfUrl: string | null;
  billingCycleStart: string | null;
  billingCycleEnd: string | null;
  createdAt: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    legalName?: string | null;
  };
  billingAccount: {
    id: string;
    billingType: string;
    paymentTermDays: number;
  };
}

interface ConsumerInvoiceItem {
  id: string;
  paymentId: string;
  userId: string;
  invoiceNumber: string;
  buyerName: string;
  buyerEmail: string | null;
  placeOfSupply: string | null;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  currency: string;
  issuedAt: string;
  status: "ISSUED" | "CREDIT_NOTED";
  creditNoteNumber: string | null;
  pdfUrl: string;
}

function getStatusBadge(status: string) {
  const styles: Record<string, string> = {
    PAID: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    ISSUED: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    OVERDUE: "bg-red-500/10 text-red-600 border-red-500/20",
    DRAFT: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20",
    CANCELLED: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
    VOID: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
    REFUNDED: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    CREDIT_NOTED: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  };
  return (
    <Badge variant="outline" className={styles[status] || ""}>
      {status.replace("_", " ")}
    </Badge>
  );
}

function useDebouncedInvoiceFilters() {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(q.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const handleSearchChange = (value: string) => {
    setQ(value);
    setPage(1);
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  return {
    statusFilter,
    q,
    debouncedQ,
    page,
    setPage,
    handleSearchChange,
    handleStatusChange,
  };
}

function InvoiceAmountAndPdfAction({
  totalPaise,
  taxPaise,
  currency,
  invoiceNumber,
  pdfHref,
}: Readonly<{
  totalPaise: number;
  taxPaise: number;
  currency: string;
  invoiceNumber: string;
  pdfHref: string | null;
}>) {
  return (
    <div className="flex items-center gap-4">
      <div className="text-right">
        <p className="font-semibold">
          {formatCurrencyAmount(totalPaise, currency)}
        </p>
        {taxPaise > 0 && (
          <p className="text-[10px] text-muted-foreground">
            incl. {formatCurrencyAmount(taxPaise, currency)} GST
          </p>
        )}
      </div>
      {pdfHref && (
        <Button variant="ghost" size="icon" asChild>
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Download PDF for ${invoiceNumber}`}
          >
            <Download className="h-4 w-4" />
          </a>
        </Button>
      )}
    </div>
  );
}

function InvoicesTabScaffold<T extends { id: string }>({
  stats,
  searchAriaLabel,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  statusAriaLabel,
  statusValue,
  statusOptions,
  onStatusChange,
  isLoading,
  isError,
  onRetry,
  emptyMessage,
  items,
  renderRow,
  pagination,
  page,
  onPageChange,
}: Readonly<{
  stats: Array<{
    title: string;
    value: string | number;
    subtitle?: string;
    variant?: "default" | "success" | "warning" | "danger";
  }>;
  searchAriaLabel: string;
  searchPlaceholder: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  statusAriaLabel: string;
  statusValue: string;
  statusOptions: Array<{ value: string; label: string }>;
  onStatusChange: (value: string) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  emptyMessage: string;
  items: T[];
  renderRow: (item: T) => ReactNode;
  pagination: InvoicePagination | undefined;
  page: number;
  onPageChange: (nextPage: number) => void;
}>) {
  let content: ReactNode;
  if (isLoading) {
    content = (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  } else if (isError && items.length === 0) {
    content = (
      <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <span>Failed to load invoices.</span>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    content = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  } else {
    content = <div className="divide-y">{items.map(renderRow)}</div>;
  }

  return (
    <div className="space-y-6">
      <DashboardGrid columns={4}>
        {stats.map((stat) => (
          <StatCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            subtitle={stat.subtitle}
            icon={FileText}
            variant={stat.variant}
            loading={isLoading}
          />
        ))}
      </DashboardGrid>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label={searchAriaLabel}
            className="pl-8"
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        <Select value={statusValue} onValueChange={onStatusChange}>
          <SelectTrigger
            aria-label={statusAriaLabel}
            className="w-full sm:w-44"
          >
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6">
          {content}

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t mt-4">
              <p className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pagination.totalPages}
                  onClick={() => onPageChange(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const B2B_STATUS_OPTIONS = [
  { value: "ALL", label: "All Statuses" },
  { value: "PAID", label: "Paid" },
  { value: "ISSUED", label: "Issued" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "DRAFT", label: "Draft" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "VOID", label: "Void" },
  { value: "REFUNDED", label: "Refunded" },
];

const B2C_STATUS_OPTIONS = [
  { value: "ALL", label: "All Statuses" },
  { value: "ISSUED", label: "Issued" },
  { value: "CREDIT_NOTED", label: "Credit Noted" },
];

function OrganizationInvoicesTab({
  apiEndpoint,
  dashboardBasePath,
  queryKeyPrefix,
}: Readonly<{
  apiEndpoint: string;
  dashboardBasePath: string;
  queryKeyPrefix: string;
}>) {
  const {
    statusFilter,
    q,
    debouncedQ,
    page,
    setPage,
    handleSearchChange,
    handleStatusChange,
  } = useDebouncedInvoiceFilters();

  const { data, isLoading, isError, refetch } = useQuery<{
    invoices: OrgInvoiceItem[];
    pagination: InvoicePagination;
    summary: {
      totalPaidPaise: number;
      totalIssuedPaise: number;
      totalOverduePaise: number;
      counts: Record<string, number>;
    };
  }>({
    queryKey: [`${queryKeyPrefix}-b2b`, statusFilter, debouncedQ, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: "b2b",
        page: page.toString(),
        limit: "20",
      });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (debouncedQ) params.set("q", debouncedQ);
      const res = await fetch(`${apiEndpoint}?${params}`);
      if (!res.ok) throw new Error("Failed to fetch organization invoices");
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const invoices = data?.invoices ?? [];
  const pagination = data?.pagination;
  const summary = data?.summary;

  return (
    <InvoicesTabScaffold<OrgInvoiceItem>
      stats={[
        {
          title: "Total B2B Invoices",
          value: pagination?.total ?? 0,
        },
        {
          title: "Paid",
          value: formatCurrencyAmount(summary?.totalPaidPaise ?? 0, "INR"),
          subtitle: `${summary?.counts?.PAID ?? 0} invoices`,
          variant: "success",
        },
        {
          title: "Issued (Pending)",
          value: formatCurrencyAmount(summary?.totalIssuedPaise ?? 0, "INR"),
          subtitle: `${summary?.counts?.ISSUED ?? 0} invoices`,
          variant: "warning",
        },
        {
          title: "Overdue",
          value: formatCurrencyAmount(summary?.totalOverduePaise ?? 0, "INR"),
          subtitle: `${summary?.counts?.OVERDUE ?? 0} invoices`,
          variant: "danger",
        },
      ]}
      searchAriaLabel="Search organization invoices"
      searchPlaceholder="Search invoice #, organization name, GSTIN…"
      searchValue={q}
      onSearchChange={handleSearchChange}
      statusAriaLabel="Filter B2B status"
      statusValue={statusFilter}
      statusOptions={B2B_STATUS_OPTIONS}
      onStatusChange={handleStatusChange}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => void refetch()}
      emptyMessage="No organization invoices found"
      items={invoices}
      pagination={pagination}
      page={page}
      onPageChange={setPage}
      renderRow={(inv) => {
        const taxPaise = inv.igstPaise + inv.cgstPaise + inv.sgstPaise;
        let pdfDownloadHref = httpsHref(inv.pdfUrl);
        if (!pdfDownloadHref && inv.status !== "DRAFT") {
          pdfDownloadHref = `/api/organizations/${inv.organization.id}/billing-account/invoices/${inv.id}/pdf`;
        }
        return (
          <div
            key={inv.id}
            className="flex items-center justify-between py-3.5 text-sm"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">
                  {inv.invoiceNumber}
                </span>
                {getStatusBadge(inv.status)}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <a
                  href={`${dashboardBasePath}/organizations/${inv.organization.id}`}
                  className="flex items-center gap-1 hover:underline"
                >
                  <Building2 className="h-3 w-3" />
                  {inv.organization.name}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
                {inv.dueDate && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Due: {new Date(inv.dueDate).toLocaleDateString()}
                  </span>
                )}
                {inv.paidAt && (
                  <span className="text-emerald-600">
                    Paid: {new Date(inv.paidAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>

            <InvoiceAmountAndPdfAction
              totalPaise={inv.totalPaise}
              taxPaise={taxPaise}
              currency={inv.displayCurrency}
              invoiceNumber={inv.invoiceNumber}
              pdfHref={pdfDownloadHref}
            />
          </div>
        );
      }}
    />
  );
}

function ConsumerInvoicesTab({
  apiEndpoint,
  dashboardBasePath,
  queryKeyPrefix,
}: Readonly<{
  apiEndpoint: string;
  dashboardBasePath: string;
  queryKeyPrefix: string;
}>) {
  const {
    statusFilter,
    q,
    debouncedQ,
    page,
    setPage,
    handleSearchChange,
    handleStatusChange,
  } = useDebouncedInvoiceFilters();

  const { data, isLoading, isError, refetch } = useQuery<{
    invoices: ConsumerInvoiceItem[];
    pagination: InvoicePagination;
    summary: {
      totalInvoices: number;
      issuedCount: number;
      creditNotedCount: number;
      totalValuePaise: number;
      taxableValuePaise: number;
    };
  }>({
    queryKey: [`${queryKeyPrefix}-b2c`, statusFilter, debouncedQ, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: "b2c",
        page: page.toString(),
        limit: "20",
      });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (debouncedQ) params.set("q", debouncedQ);
      const res = await fetch(`${apiEndpoint}?${params}`);
      if (!res.ok) throw new Error("Failed to fetch consumer invoices");
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const invoices = data?.invoices ?? [];
  const pagination = data?.pagination;
  const summary = data?.summary;

  return (
    <InvoicesTabScaffold<ConsumerInvoiceItem>
      stats={[
        {
          title: "Total B2C Invoices",
          value: summary?.totalInvoices ?? 0,
        },
        {
          title: "Gross Invoiced",
          value: formatCurrencyAmount(summary?.totalValuePaise ?? 0, "INR"),
          subtitle: `${summary?.issuedCount ?? 0} active`,
          variant: "success",
        },
        {
          title: "Taxable Supply",
          value: formatCurrencyAmount(summary?.taxableValuePaise ?? 0, "INR"),
        },
        {
          title: "Credit Noted",
          value: summary?.creditNotedCount ?? 0,
          subtitle: "Reversed via s.34 CN",
          variant: "warning",
        },
      ]}
      searchAriaLabel="Search consumer invoices"
      searchPlaceholder="Search invoice #, buyer name, email, or payment ID…"
      searchValue={q}
      onSearchChange={handleSearchChange}
      statusAriaLabel="Filter B2C status"
      statusValue={statusFilter}
      statusOptions={B2C_STATUS_OPTIONS}
      onStatusChange={handleStatusChange}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => void refetch()}
      emptyMessage="No consumer tax invoices found"
      items={invoices}
      pagination={pagination}
      page={page}
      onPageChange={setPage}
      renderRow={(inv) => {
        const taxPaise = inv.igstPaise + inv.cgstPaise + inv.sgstPaise;
        return (
          <div
            key={inv.id}
            className="flex items-center justify-between py-3.5 text-sm"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">
                  {inv.invoiceNumber}
                </span>
                {getStatusBadge(inv.status)}
                {inv.creditNoteNumber && (
                  <Badge variant="outline" className="font-mono text-xs">
                    CN: {inv.creditNoteNumber}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <a
                  href={`${dashboardBasePath}/users/${inv.userId}`}
                  className="flex items-center gap-1 hover:underline"
                >
                  {inv.buyerName}
                  {inv.buyerEmail ? ` (${inv.buyerEmail})` : ""}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
                <a
                  href={`${dashboardBasePath}/payments/${inv.paymentId}`}
                  className="font-mono hover:underline"
                >
                  Payment: {inv.paymentId.slice(0, 10)}…
                </a>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  Issued: {new Date(inv.issuedAt).toLocaleDateString()}
                </span>
              </div>
            </div>

            <InvoiceAmountAndPdfAction
              totalPaise={inv.totalPaise}
              taxPaise={taxPaise}
              currency={inv.currency}
              invoiceNumber={inv.invoiceNumber}
              pdfHref={inv.pdfUrl}
            />
          </div>
        );
      }}
    />
  );
}

export function InvoicesPage({
  title,
  subtitle,
  description,
  apiEndpoint,
  dashboardBasePath = "/dashboard/admin",
  queryKeyPrefix,
}: InvoicesPageProps) {
  return (
    <>
      <DashboardHeader title={title} subtitle={subtitle ?? description} />
      <DashboardContent>
        <UrlTabs
          tabs={[
            {
              value: "b2b",
              label: "Organization (B2B)",
              content: (
                <OrganizationInvoicesTab
                  apiEndpoint={apiEndpoint}
                  dashboardBasePath={dashboardBasePath}
                  queryKeyPrefix={queryKeyPrefix}
                />
              ),
            },
            {
              value: "b2c",
              label: "Consumer (B2C)",
              content: (
                <ConsumerInvoicesTab
                  apiEndpoint={apiEndpoint}
                  dashboardBasePath={dashboardBasePath}
                  queryKeyPrefix={queryKeyPrefix}
                />
              ),
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
