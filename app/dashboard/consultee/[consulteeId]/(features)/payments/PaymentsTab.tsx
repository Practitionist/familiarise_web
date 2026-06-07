"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { useCurrency } from "@/hooks/useCurrency";
import { cn } from "@/utils/tailwind";
import {
  CreditCard,
  Gift,
  Download,
  FileText,
  Tag,
  ArrowUpDown,
  Building2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PaymentItem {
  id: string;
  amount: number;
  originalAmount: number | null;
  taxAmount: number | null;
  currency: string;
  status: string;
  paymentMethod: string | null;
  paymentGateway: string;
  appointmentType: string | null;
  planTitle: string;
  organizationId: string | null;
  discount: {
    code: string;
    type: string;
    value: number;
  } | null;
  receiptUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface InvoiceItem {
  id: string;
  paymentId: string | null;
  invoiceNumber: string;
  amount: number;
  taxAmount: number | null;
  status: string;
  createdAt: string;
  payment: {
    id: string;
    amount: number;
    currency: string;
    paymentStatus: string;
  } | null;
}

interface CreditItem {
  id: string;
  amount: number;
  source: string;
  usedAmount: number;
  remainingAmount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface CreditUsageItem {
  id: string;
  amount: number;
  usedAt: string;
  credit: { source: string };
  payment: {
    id: string;
    amount: number;
    currency: string;
    createdAt: string;
  } | null;
}

interface PaymentsData {
  payments: PaymentItem[];
  invoices: InvoiceItem[];
  credits: CreditItem[];
  creditUsages: CreditUsageItem[];
  creditSummary: {
    total: number;
    used: number;
    remaining: number;
  };
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const GATEWAY_LABELS: Record<string, string> = {
  STRIPE: "Stripe",
  RAZORPAY: "Razorpay",
  LEMON_SQUEEZY: "Lemon Squeezy",
  XFLOW: "Xflow",
};

function formatGateway(gateway: string): string {
  return GATEWAY_LABELS[gateway] || gateway;
}

function formatDateTime(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isPast = diffMs < 0;

  const minutes = Math.floor(absDiffMs / (1000 * 60));
  const hours = Math.floor(absDiffMs / (1000 * 60 * 60));
  const days = Math.floor(absDiffMs / (1000 * 60 * 60 * 24));

  let relative: string;
  if (minutes < 1) relative = "just now";
  else if (minutes < 60) relative = `${minutes}m`;
  else if (hours < 24) relative = `${hours}h ${minutes % 60}m`;
  else relative = `${days}d ago`;

  if (minutes < 1) return relative;
  return isPast ? `${relative} ago` : `in ${relative}`;
}

/**
 * Derive UI display status: if PENDING but expiresAt is past, show EXPIRED
 * so the user doesn't see a misleading amber "PENDING" badge while the
 * cleanup cron hasn't run yet.
 */
function getDisplayStatus(payment: PaymentItem): string {
  if (payment.status !== "PENDING") return payment.status;

  const expiresAt = payment.expiresAt
    ? new Date(payment.expiresAt)
    : new Date(new Date(payment.createdAt).getTime() + 30 * 60 * 1000);

  return expiresAt <= new Date() ? "EXPIRED" : "PENDING";
}

function getExpiryInfo(payment: PaymentItem): {
  datetime: string;
  relative: string;
  isExpired: boolean;
} | null {
  // Show expiry info for PENDING (countdown) and EXPIRED (how long ago)
  if (payment.status !== "PENDING" && payment.status !== "EXPIRED") return null;

  const expiresAt = payment.expiresAt
    ? new Date(payment.expiresAt)
    : new Date(new Date(payment.createdAt).getTime() + 30 * 60 * 1000);

  return {
    datetime: formatDateTime(expiresAt.toISOString()),
    relative: formatRelativeTime(expiresAt),
    isExpired: expiresAt <= new Date(),
  };
}

const STATUS_STYLES: Record<string, string> = {
  SUCCEEDED: "bg-emerald-50 text-emerald-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  PENDING: "bg-amber-50 text-amber-700",
  EXPIRED: "bg-zinc-100 text-zinc-500",
  FAILED: "bg-red-50 text-red-700",
  REFUNDED: "bg-blue-50 text-blue-700",
  CANCELLED: "bg-zinc-100 text-zinc-600",
  PAID: "bg-emerald-50 text-emerald-700",
  UNPAID: "bg-amber-50 text-amber-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
        STATUS_STYLES[status] || "bg-zinc-100 text-zinc-600",
      )}
    >
      {status}
    </span>
  );
}

export function PaymentsTab({ data }: { data: PaymentsData | undefined }) {
  const { formatPrice } = useCurrency();
  const { data: session } = useSession();
  // Resolve a payment's `organizationId` to a displayable org name for
  // the "Sponsored · <Org>" badge — same convention as the appointments
  // / home surfaces.
  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoringOrgName = (
    orgId: string | null | undefined,
  ): string | null => {
    if (!orgId) return null;
    return (
      orgMemberships.find((m) => m.organizationId === orgId)?.organizationName ??
      "the organization"
    );
  };

  // Build a map from paymentId → invoice for quick lookup
  const invoiceByPaymentId = useMemo(() => {
    if (!data) return new Map<string, InvoiceItem>();
    const map = new Map<string, InvoiceItem>();
    for (const inv of data.invoices) {
      if (inv.paymentId) {
        map.set(inv.paymentId, inv);
      }
    }
    return map;
  }, [data]);

  // TODO: currently sums all currencies as INR — add multi-currency support later
  const totalSpent = useMemo(() => {
    if (!data) return 0;
    return data.payments
      .filter((p) => p.status === "SUCCEEDED")
      .reduce((sum, p) => sum + p.amount, 0);
  }, [data]);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const filteredPayments = useMemo(() => {
    let result = data?.payments ?? [];
    if (statusFilter !== "all") {
      result = result.filter((p) => getDisplayStatus(p) === statusFilter);
    }
    if (typeFilter !== "all") {
      result = result.filter(
        (p) => p.appointmentType?.toUpperCase() === typeFilter,
      );
    }
    result = [...result].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDir === "asc" ? diff : -diff;
    });
    return result;
  }, [data, statusFilter, typeFilter, sortDir]);

  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Payments</h1>
        <p className="text-zinc-500 mt-1">Your payment history and credits</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-sm text-zinc-500 cursor-help w-fit">
                  Total Spent{" "}
                  <span className="text-zinc-400">&#9432;</span>
                </p>
              </TooltipTrigger>
              <TooltipContent>
                <p>Only includes successful payments</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <p className="text-2xl font-bold text-zinc-900">
            {formatPrice(totalSpent)}
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {(() => {
              const count = data.payments.filter((p) => p.status === "SUCCEEDED").length;
              return `${count} successful ${count === 1 ? "transaction" : "transactions"} `;
            })()}
            &middot; {data.payments.length} total
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Credits Earned</p>
          <p className="text-2xl font-bold text-zinc-900">
            {formatPrice(data.creditSummary.total)}
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {formatPrice(data.creditSummary.used)} used
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Credit Balance</p>
          <p className="text-2xl font-bold text-emerald-600">
            {formatPrice(data.creditSummary.remaining)}
          </p>
          <p className="text-xs text-zinc-400 mt-1">Available to use</p>
        </div>
      </div>

      <Tabs defaultValue="payments" className="space-y-6">
        <TabsList>
          <TabsTrigger value="payments">
            <CreditCard className="w-4 h-4 mr-1.5" />
            Transactions
          </TabsTrigger>
          <TabsTrigger value="credits">
            <Gift className="w-4 h-4 mr-1.5" />
            Credits
          </TabsTrigger>
        </TabsList>

        {/* Payments (merged transactions + invoices) */}
        <TabsContent value="payments">
          {data.payments.length === 0 ? (
            <EmptyState message="No payments yet" />
          ) : (
            <div className="space-y-3">
              {/* Filter / Sort bar */}
              <div className="flex flex-wrap items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="EXPIRED">Expired</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[170px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="CONSULTATION">Consultation</SelectItem>
                    <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                    <SelectItem value="WEBINAR">Webinar</SelectItem>
                    <SelectItem value="CLASS">Class</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                  }
                  className="gap-1.5"
                >
                  <ArrowUpDown className="w-3.5 h-3.5" />
                  {sortDir === "desc" ? "Newest first" : "Oldest first"}
                </Button>
              </div>

              {filteredPayments.length === 0 ? (
                <EmptyState message="No transactions match the selected filters" />
              ) : (
            <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 bg-zinc-50">
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Date
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Invoice #
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Plan
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Type
                      </th>
                      <th className="text-right px-4 py-3 font-medium text-zinc-600">
                        Amount
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Method
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Status
                      </th>
                      <th className="text-left px-4 py-3 font-medium text-zinc-600">
                        Expires
                      </th>
                      <th className="text-center px-4 py-3 font-medium text-zinc-600">
                        Invoice
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {filteredPayments.map((payment) => {
                      const invoice = invoiceByPaymentId.get(payment.id);
                      const displayStatus = getDisplayStatus(payment);
                      return (
                        <tr key={payment.id} className="hover:bg-zinc-50">
                          <td className="px-4 py-3 text-zinc-600 whitespace-nowrap">
                            {formatDate(payment.createdAt)}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-zinc-500 whitespace-nowrap">
                            {invoice?.invoiceNumber || (
                              <span className="text-zinc-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-zinc-900 font-medium max-w-[220px]">
                            <div className="truncate">{payment.planTitle}</div>
                            {(() => {
                              const sponsoringOrgName =
                                resolveSponsoringOrgName(payment.organizationId);
                              return sponsoringOrgName ? (
                                <Badge
                                  className="mt-1 text-[10px] font-semibold px-2 py-0.5 bg-indigo-50 text-indigo-700 border-0 rounded-md inline-flex items-center gap-1 max-w-full"
                                  title={`Sponsored by ${sponsoringOrgName}`}
                                >
                                  <Building2 className="h-3 w-3 shrink-0" />
                                  <span className="truncate">
                                    Sponsored · {sponsoringOrgName}
                                  </span>
                                </Badge>
                              ) : null;
                            })()}
                          </td>
                          <td className="px-4 py-3 text-zinc-600 whitespace-nowrap capitalize">
                            {payment.appointmentType?.toLowerCase() || "—"}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <span className="font-medium text-zinc-900">
                              {formatPrice(payment.amount)}
                            </span>
                            {payment.taxAmount && payment.taxAmount > 0 && (
                              <span className="block text-xs text-zinc-400">
                                incl.{" "}
                                {formatPrice(payment.taxAmount ?? 0)}{" "}
                                GST
                              </span>
                            )}
                            {payment.discount && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex items-center text-emerald-600 ml-1 cursor-help">
                                      <Tag className="w-3 h-3" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>
                                      &ldquo;{payment.discount.code}&rdquo;
                                      {" \u2014 "}
                                      {payment.discount.type === "PERCENTAGE"
                                        ? `${payment.discount.value}% off`
                                        : `${formatPrice(payment.discount.value)} off`}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </td>
                          <td className="px-4 py-3 text-zinc-600 whitespace-nowrap text-xs">
                            {formatGateway(payment.paymentGateway)}
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={displayStatus} />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            {(() => {
                              const expiry = getExpiryInfo(payment);
                              if (!expiry) {
                                return <span className="text-zinc-300">—</span>;
                              }
                              return (
                                <div>
                                  <span className="text-xs text-zinc-500">
                                    {expiry.datetime}
                                  </span>
                                  <span
                                    className={cn(
                                      "block text-xs",
                                      expiry.isExpired
                                        ? "text-zinc-400"
                                        : "text-amber-600",
                                    )}
                                  >
                                    {expiry.relative}
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {invoice ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-zinc-500 hover:text-zinc-900"
                                      onClick={() => {
                                        window.open(
                                          `/api/invoices/${invoice.id}/pdf`,
                                          "_blank",
                                        );
                                      }}
                                    >
                                      <Download className="w-4 h-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Download invoice PDF</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : displayStatus === "FAILED" ||
                              displayStatus === "EXPIRED" ? (
                              <span className="text-xs text-zinc-300">—</span>
                            ) : (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <FileText className="w-4 h-4 text-zinc-200 mx-auto" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Invoice pending</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* Credits */}
        <TabsContent value="credits">
          <div className="space-y-6">
            {/* Credits list */}
            {data.credits.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 bg-white rounded-xl border border-zinc-200">
                <Gift className="w-8 h-8 text-zinc-300 mb-3" />
                <p className="text-zinc-500">No credits yet</p>
                <p className="text-sm text-zinc-400 mt-1">
                  Refer friends to earn credits you can use on future bookings.
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-100 bg-zinc-50">
                        <th className="text-left px-4 py-3 font-medium text-zinc-600">
                          Date
                        </th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-600">
                          Source
                        </th>
                        <th className="text-right px-4 py-3 font-medium text-zinc-600">
                          Amount
                        </th>
                        <th className="text-right px-4 py-3 font-medium text-zinc-600">
                          Remaining
                        </th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-600">
                          Expires
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {data.credits.map((credit) => (
                        <tr key={credit.id} className="hover:bg-zinc-50">
                          <td className="px-4 py-3 text-zinc-600 whitespace-nowrap">
                            {formatDate(credit.createdAt)}
                          </td>
                          <td className="px-4 py-3 text-zinc-900 capitalize">
                            {credit.source.toLowerCase().replace(/_/g, " ")}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-zinc-900">
                            {formatPrice(credit.amount)}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-emerald-600">
                            {formatPrice(credit.remainingAmount)}
                          </td>
                          <td className="px-4 py-3 text-zinc-500">
                            {credit.expiresAt
                              ? formatDate(credit.expiresAt)
                              : "No expiry"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Credit usage history */}
            {data.creditUsages.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-zinc-700 mb-3">
                  Usage History
                </h3>
                <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-100 bg-zinc-50">
                          <th className="text-left px-4 py-3 font-medium text-zinc-600">
                            Date
                          </th>
                          <th className="text-left px-4 py-3 font-medium text-zinc-600">
                            Source
                          </th>
                          <th className="text-right px-4 py-3 font-medium text-zinc-600">
                            Used
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-50">
                        {data.creditUsages.map((usage) => (
                          <tr key={usage.id} className="hover:bg-zinc-50">
                            <td className="px-4 py-3 text-zinc-600">
                              {formatDate(usage.usedAt)}
                            </td>
                            <td className="px-4 py-3 text-zinc-900 capitalize">
                              {usage.credit.source
                                .toLowerCase()
                                .replace(/_/g, " ")}
                            </td>
                            <td className="px-4 py-3 text-right font-medium text-red-600">
                              -{formatPrice(usage.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 bg-white rounded-xl border border-zinc-200">
      <p className="text-zinc-500">{message}</p>
    </div>
  );
}
