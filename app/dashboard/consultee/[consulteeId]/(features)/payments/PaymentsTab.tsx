"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import type {
  ConsulteeCreditRow,
  ConsulteeCreditUsageRow,
  ConsulteePaymentsPayload,
} from "@/lib/data/consultee-payments";
import { motion } from "framer-motion";
import { useCurrency } from "@/hooks/useCurrency";
import { CreditCard, Gift } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { NeedsYouBand } from "./NeedsYouBand";
import { PaymentsHistoryList } from "./PaymentsHistoryList";

type CreditItem = ConsulteeCreditRow;
type CreditUsageItem = ConsulteeCreditUsageRow;
type PaymentsData = ConsulteePaymentsPayload;

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format an amount in ITS OWN currency (no cross-currency conversion) —
 * used by the per-currency summary so a USD payment is never summed or
 * displayed as INR.
 */
function formatAmountInCurrency(paise: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(paise / 100);
  } catch {
    return `${currency} ${(paise / 100).toFixed(2)}`;
  }
}

async function fetchConsulteePayments(
  consulteeId: string,
): Promise<PaymentsData> {
  const res = await fetch(`/api/dashboard/consultee/${consulteeId}/payments`);
  if (!res.ok) throw new Error("Failed to fetch payments");
  const json = await res.json();
  return json.data;
}

export function PaymentsTab({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  // Personal pin, matching the sibling Appointments page (ADR 19); the route
  // defaults personal without ?orgScope=. The RSC page seeds this exact key.
  const { data, isLoading, error } = useQuery({
    queryKey: ["consultee-payments", consulteeId, "personal"] as const,
    queryFn: () => fetchConsulteePayments(consulteeId),
    staleTime: 30 * 1000,
    // E2E-audit P1 fix — the global query client sets refetchOnMount /
    // refetchOnWindowFocus to false, so a purchase made elsewhere in the same
    // SPA session never appeared here until a full reload. Remounting this tab
    // must always revalidate: the newest transaction (and REFUNDED flips caused
    // by auto-refunds) land within one navigation; the SSR seed only covers
    // the first paint.
    refetchOnMount: "always",
  });

  if (isLoading) return <PageSkeleton />;

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
          <h3 className="font-semibold mb-2">Error Loading Payments</h3>
          <p className="text-sm">
            {error?.message || "Failed to load payments. Please try again."}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <DashboardErrorBoundary>
      <PaymentsTabBody data={data} consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}

function PaymentsTabBody({
  data,
  consulteeId,
}: Readonly<{
  data: PaymentsData;
  consulteeId: string;
}>) {
  const { formatPrice } = useCurrency();

  // Net successful spend grouped per currency — a USD payment must never be
  // summed into an INR total, and refunded amounts don't count as spend.
  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const p of data?.payments ?? []) {
      if (p.status !== "SUCCEEDED") continue;
      const currency = p.currency || "INR";
      const entry = map.get(currency) ?? { total: 0, count: 0 };
      entry.total += p.amount - (p.refundedPaise ?? 0);
      entry.count += 1;
      map.set(currency, entry);
    }
    return map;
  }, [data]);

  const creditColumns: ResponsiveColumn<CreditItem>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (credit) => (
        <span className="capitalize text-foreground">
          {credit.source.toLowerCase().replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (credit) => (
        <span className="text-muted-foreground whitespace-nowrap">
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
        <span className="font-medium text-foreground">
          {formatPrice(credit.amount)}
        </span>
      ),
    },
    {
      key: "remaining",
      header: "Remaining",
      headClassName: "text-right",
      className: "text-right",
      cell: (credit) => (
        <span className="font-medium text-green-600 dark:text-green-400">
          {formatPrice(credit.remainingAmount)}
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

  const creditUsageColumns: ResponsiveColumn<CreditUsageItem>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (usage) => (
        <span className="capitalize text-foreground">
          {usage.credit.source.toLowerCase().replace(/_/g, " ")}
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
        <span className="font-medium text-red-600 dark:text-red-400">
          -{formatPrice(usage.amount)}
        </span>
      ),
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <DashboardHeader
          title="Payments"
          subtitle="Your payment history and credits"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-xl border border-border p-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-sm text-muted-foreground cursor-help w-fit">
                  Total Spent{" "}
                  <span className="text-muted-foreground/70">&#9432;</span>
                </p>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Successful payments net of refunds. Multi-currency spend is
                  totalled per currency, never converted.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {totalsByCurrency.size === 0 ? (
            <p className="text-2xl font-bold text-foreground">
              {formatPrice(0)}
            </p>
          ) : (
            <div className="space-y-0.5">
              {Array.from(totalsByCurrency.entries()).map(
                ([currency, entry]) => (
                  <p
                    key={currency}
                    className="text-2xl font-bold text-foreground leading-tight"
                  >
                    {formatAmountInCurrency(entry.total, currency)}
                  </p>
                ),
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground/70 mt-1">
            {(() => {
              const count = data.payments.filter(
                (p) => p.status === "SUCCEEDED",
              ).length;
              return `${count} successful ${count === 1 ? "transaction" : "transactions"} `;
            })()}
            &middot; {data.payments.length} total
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">Credits Earned</p>
          <p className="text-2xl font-bold text-foreground">
            {formatPrice(data.creditSummary.total)}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {formatPrice(data.creditSummary.used)} used
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">Credit Balance</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatPrice(data.creditSummary.remaining)}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Available to use
          </p>
        </div>
      </div>

      <Tabs defaultValue="payments" className="space-y-6">
        <TabsList>
          <TabsTrigger value="payments">
            <CreditCard className="w-4 h-4 mr-1.5" />
            Payments
          </TabsTrigger>
          <TabsTrigger value="credits">
            <Gift className="w-4 h-4 mr-1.5" />
            Credits
          </TabsTrigger>
        </TabsList>

        {/* #1675 X3 — Needs you (only when non-empty) + History */}
        <TabsContent value="payments">
          <NeedsYouBand consulteeId={consulteeId} />
          <PaymentsHistoryList
            payments={data.payments}
            consulteeId={consulteeId}
          />
        </TabsContent>

        {/* Credits */}
        <TabsContent value="credits">
          <div className="space-y-6">
            {/* Credits list */}
            {data.credits.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 bg-card rounded-xl border border-border">
                <Gift className="w-8 h-8 text-muted-foreground/70 mb-3" />
                <p className="text-muted-foreground">No credits yet</p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  Refer friends to earn credits you can use on future bookings.
                </p>
              </div>
            ) : (
              <div className="bg-card rounded-xl border border-border p-2 sm:p-3">
                <ResponsiveTable<CreditItem>
                  columns={creditColumns}
                  rows={data.credits}
                  getRowId={(c) => c.id}
                />
              </div>
            )}

            {/* Credit usage history */}
            {data.creditUsages.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  Usage History
                </h3>
                <div className="bg-card rounded-xl border border-border p-2 sm:p-3">
                  <ResponsiveTable<CreditUsageItem>
                    columns={creditUsageColumns}
                    rows={data.creditUsages}
                    getRowId={(u) => u.id}
                  />
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}
