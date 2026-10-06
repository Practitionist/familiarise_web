"use client";

import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  FileText,
  Download,
  Building2,
  Calendar,
  ExternalLink,
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

function OrganizationInvoicesTab({
  apiEndpoint,
  dashboardBasePath,
  queryKeyPrefix,
}: Readonly<{
  apiEndpoint: string;
  dashboardBasePath: string;
  queryKeyPrefix: string;
}>) {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<{
    invoices: OrgInvoiceItem[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    summary: {
      totalPaidPaise: number;
      totalIssuedPaise: number;
      totalOverduePaise: number;
      counts: Record<string, number>;
    };
  }>({
    queryKey: [`${queryKeyPrefix}-b2b`, statusFilter, q, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: "b2b",
        page: page.toString(),
        limit: "20",
      });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (q.trim()) params.set("q", q.trim());
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
    <div className="space-y-6">
      <DashboardGrid columns={4}>
        <StatCard
          title="Total B2B Invoices"
          value={pagination?.total ?? 0}
          icon={FileText}
          loading={isLoading}
        />
        <StatCard
          title="Paid"
          value={formatCurrencyAmount(summary?.totalPaidPaise ?? 0, "INR")}
          subtitle={`${summary?.counts?.PAID ?? 0} invoices`}
          icon={FileText}
          variant="success"
          loading={isLoading}
        />
        <StatCard
          title="Issued (Pending)"
          value={formatCurrencyAmount(summary?.totalIssuedPaise ?? 0, "INR")}
          subtitle={`${summary?.counts?.ISSUED ?? 0} invoices`}
          icon={FileText}
          variant="warning"
          loading={isLoading}
        />
        <StatCard
          title="Overdue"
          value={formatCurrencyAmount(summary?.totalOverduePaise ?? 0, "INR")}
          subtitle={`${summary?.counts?.OVERDUE ?? 0} invoices`}
          icon={FileText}
          variant="danger"
          loading={isLoading}
        />
      </DashboardGrid>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search organization invoices"
            className="pl-8"
            placeholder="Search invoice #, organization name, GSTIN…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger
            aria-label="Filter B2B status"
            className="w-full sm:w-44"
          >
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Statuses</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
            <SelectItem value="ISSUED">Issued</SelectItem>
            <SelectItem value="OVERDUE">Overdue</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
            <SelectItem value="VOID">Void</SelectItem>
            <SelectItem value="REFUNDED">Refunded</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Organization Invoices ({pagination?.total ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : invoices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No organization invoices found
            </p>
          ) : (
            <div className="divide-y">
              {invoices.map((inv) => {
                const taxPaise = inv.igstPaise + inv.cgstPaise + inv.sgstPaise;
                const pdfDownloadHref =
                  inv.pdfUrl ||
                  (inv.status !== "DRAFT"
                    ? `/api/organizations/${inv.organization.id}/billing-account/invoices/${inv.id}/pdf`
                    : null);
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

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-semibold">
                          {formatCurrencyAmount(
                            inv.totalPaise,
                            inv.displayCurrency,
                          )}
                        </p>
                        {taxPaise > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            incl.{" "}
                            {formatCurrencyAmount(
                              taxPaise,
                              inv.displayCurrency,
                            )}{" "}
                            GST
                          </p>
                        )}
                      </div>
                      {pdfDownloadHref && (
                        <Button variant="ghost" size="icon" asChild>
                          <a
                            href={pdfDownloadHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Download PDF for ${inv.invoiceNumber}`}
                          >
                            <Download className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

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
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage(page + 1)}
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

function ConsumerInvoicesTab({
  apiEndpoint,
  dashboardBasePath,
  queryKeyPrefix,
}: Readonly<{
  apiEndpoint: string;
  dashboardBasePath: string;
  queryKeyPrefix: string;
}>) {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<{
    invoices: ConsumerInvoiceItem[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    summary: {
      totalInvoices: number;
      issuedCount: number;
      creditNotedCount: number;
      totalValuePaise: number;
      taxableValuePaise: number;
    };
  }>({
    queryKey: [`${queryKeyPrefix}-b2c`, statusFilter, q, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: "b2c",
        page: page.toString(),
        limit: "20",
      });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (q.trim()) params.set("q", q.trim());
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
    <div className="space-y-6">
      <DashboardGrid columns={4}>
        <StatCard
          title="Total B2C Invoices"
          value={summary?.totalInvoices ?? 0}
          icon={FileText}
          loading={isLoading}
        />
        <StatCard
          title="Gross Invoiced"
          value={formatCurrencyAmount(summary?.totalValuePaise ?? 0, "INR")}
          subtitle={`${summary?.issuedCount ?? 0} active`}
          icon={FileText}
          variant="success"
          loading={isLoading}
        />
        <StatCard
          title="Taxable Supply"
          value={formatCurrencyAmount(summary?.taxableValuePaise ?? 0, "INR")}
          icon={FileText}
          loading={isLoading}
        />
        <StatCard
          title="Credit Noted"
          value={summary?.creditNotedCount ?? 0}
          subtitle="Reversed via s.34 CN"
          icon={FileText}
          variant="warning"
          loading={isLoading}
        />
      </DashboardGrid>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search consumer invoices"
            className="pl-8"
            placeholder="Search invoice #, buyer name, email, or payment ID…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger
            aria-label="Filter B2C status"
            className="w-full sm:w-44"
          >
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Statuses</SelectItem>
            <SelectItem value="ISSUED">Issued</SelectItem>
            <SelectItem value="CREDIT_NOTED">Credit Noted</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Consumer Tax Invoices ({pagination?.total ?? 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : invoices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No consumer tax invoices found
            </p>
          ) : (
            <div className="divide-y">
              {invoices.map((inv) => {
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
                          <Badge
                            variant="outline"
                            className="font-mono text-xs"
                          >
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

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-semibold">
                          {formatCurrencyAmount(inv.totalPaise, inv.currency)}
                        </p>
                        {taxPaise > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            incl. {formatCurrencyAmount(taxPaise, inv.currency)}{" "}
                            GST
                          </p>
                        )}
                      </div>
                      <Button variant="ghost" size="icon" asChild>
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Download PDF for ${inv.invoiceNumber}`}
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

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
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage(page + 1)}
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
