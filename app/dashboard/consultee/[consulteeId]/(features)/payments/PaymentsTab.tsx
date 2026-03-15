"use client";

import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import {
  formatCurrencyAmount,
  formatCurrencyFromMajorUnit,
} from "@/utils/formatting";
import { cn } from "@/utils/tailwind";
import { CreditCard, Gift, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

  const totalSpent = useMemo(() => {
    if (!data) return 0;
    return data.payments
      .filter((p) => p.status === "SUCCEEDED")
      .reduce((sum, p) => sum + p.amount, 0);
  }, [data]);

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
          <p className="text-sm text-zinc-500">Total Spent</p>
          <p className="text-2xl font-bold text-zinc-900">
            {formatCurrencyFromMajorUnit(totalSpent, "INR")}
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {data.payments.filter((p) => p.status === "SUCCEEDED").length}{" "}
            transactions
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Credits Earned</p>
          <p className="text-2xl font-bold text-zinc-900">
            {formatCurrencyAmount(data.creditSummary.total, "INR")}
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {formatCurrencyAmount(data.creditSummary.used, "INR")} used
          </p>
        </div>
        <div className="bg-white rounded-xl border border-zinc-200 p-4">
          <p className="text-sm text-zinc-500">Credit Balance</p>
          <p className="text-2xl font-bold text-emerald-600">
            {formatCurrencyAmount(data.creditSummary.remaining, "INR")}
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
                    {data.payments.map((payment) => {
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
                          <td className="px-4 py-3 text-zinc-900 font-medium max-w-[200px] truncate">
                            {payment.planTitle}
                          </td>
                          <td className="px-4 py-3 text-zinc-600 whitespace-nowrap capitalize">
                            {payment.appointmentType?.toLowerCase() || "—"}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <span className="font-medium text-zinc-900">
                              {formatCurrencyFromMajorUnit(
                                payment.amount,
                                payment.currency,
                              )}
                            </span>
                            {payment.taxAmount && payment.taxAmount > 0 && (
                              <span className="block text-xs text-zinc-400">
                                incl.{" "}
                                {formatCurrencyFromMajorUnit(
                                  payment.taxAmount,
                                  payment.currency,
                                )}{" "}
                                GST
                              </span>
                            )}
                            {payment.discount && (
                              <span className="block text-xs text-emerald-600">
                                {payment.discount.code} applied
                              </span>
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
                                        // TODO: Replace with actual PDF download when @react-pdf/renderer is integrated
                                        // Will call: GET /api/invoices/{invoice.id}/pdf
                                        window.alert(
                                          `PDF download coming soon.\n\nInvoice: ${invoice.invoiceNumber}\nAmount: ${formatCurrencyFromMajorUnit(invoice.amount, "INR")}`,
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
        </TabsContent>

        {/* Credits */}
        <TabsContent value="credits">
          <div className="space-y-6">
            {/* Credits list */}
            {data.credits.length === 0 ? (
              <EmptyState message="No credits yet. Refer friends to earn credits!" />
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
                            {formatCurrencyAmount(credit.amount, "INR")}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-emerald-600">
                            {formatCurrencyAmount(
                              credit.remainingAmount,
                              "INR",
                            )}
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
                              -{formatCurrencyAmount(usage.amount, "INR")}
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
