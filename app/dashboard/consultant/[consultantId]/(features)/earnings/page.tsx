"use client";

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard } from "@/components/dashboard/StatCard";
import { Badge } from "@/components/ui/badge";
import {
  Wallet,
  Clock,
  CheckCircle,
  AlertTriangle,
  IndianRupee,
  ArrowUpRight,
  Loader2,
} from "lucide-react";
import { formatCurrencyAmount } from "@/lib/utils";

type EarningStatus = "PENDING" | "READY" | "PAID" | "HELD" | "REFUNDED";

interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
}

interface EarningRecord {
  id: string;
  consultantShare: number;
  platformFee: number;
  status: EarningStatus;
  holdUntil: string | null;
  createdAt: string;
  role: "OWNER" | "COLLABORATOR";
  sharePercentage: number;
  payment: {
    id: string;
    amount: number;
    currency: string;
    createdAt: string;
    appointment: {
      id: string;
      appointmentType: string;
    } | null;
  };
  payout: {
    id: string;
    status: string;
    processedAt: string | null;
  } | null;
}

interface EarningsResponse {
  summary: EarningsSummary;
  eligibility: {
    isEligible: boolean;
    reason?: string;
    readyAmount: number;
    minimumAmount: number;
  };
  earnings: EarningRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * Format currency using the shared utility.
 * Summary amounts don't carry a currency (backend aggregates across all),
 * so we default to INR. Individual earning rows use payment.currency.
 */
const formatSummaryAmount = (amount: number) =>
  formatCurrencyAmount(amount, "INR");

const formatEarningAmount = (amount: number, currency: string) =>
  formatCurrencyAmount(amount, currency);

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const statusConfig: Record<
  EarningStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className: string }
> = {
  PENDING: {
    label: "Pending",
    variant: "secondary",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  READY: {
    label: "Ready for Payout",
    variant: "default",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  PAID: {
    label: "Paid",
    variant: "default",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  HELD: {
    label: "On Hold",
    variant: "destructive",
    className: "bg-red-50 text-red-700 border-red-200",
  },
  REFUNDED: {
    label: "Refunded",
    variant: "outline",
    className: "bg-zinc-50 text-zinc-500 border-zinc-200",
  },
};

export default function EarningsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);
  const [statusFilter, setStatusFilter] = useState<EarningStatus | "ALL">(
    "ALL",
  );
  const [page, setPage] = useState(0);
  const limit = 15;

  const { data, isLoading, error } = useQuery<EarningsResponse>({
    queryKey: ["consultant-earnings", consultantId, statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      params.set("limit", String(limit));
      params.set("offset", String(page * limit));
      const res = await fetch(`/api/consultant/earnings?${params}`);
      if (!res.ok) throw new Error("Failed to fetch earnings");
      return res.json();
    },
    staleTime: 30_000,
  });

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="p-6 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
          <h3 className="font-semibold mb-1">Error Loading Earnings</h3>
          <p className="text-sm">
            {error instanceof Error ? error.message : "Please try again later."}
          </p>
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const earnings = data?.earnings ?? [];
  const eligibility = data?.eligibility;
  const pagination = data?.pagination;

  const filterTabs: { label: string; value: EarningStatus | "ALL" }[] = [
    { label: "All", value: "ALL" },
    { label: "Pending", value: "PENDING" },
    { label: "Ready", value: "READY" },
    { label: "Paid", value: "PAID" },
    { label: "On Hold", value: "HELD" },
    { label: "Refunded", value: "REFUNDED" },
  ];

  return (
    <>
      <DashboardHeader
        title="Earnings"
        subtitle="Track your income from consultations, subscriptions, webinars, and classes"
      />
      <DashboardContent>
        {/* Summary Cards */}
        <DashboardGrid columns={4}>
          <StatCard
            title="Total Earnings"
            value={formatSummaryAmount(summary?.totalEarnings ?? 0)}
            icon={IndianRupee}
            variant="default"
          />
          <StatCard
            title="Ready for Payout"
            value={formatSummaryAmount(summary?.readyEarnings ?? 0)}
            icon={CheckCircle}
            variant="success"
            subtitle={
              eligibility?.isEligible
                ? "Eligible for payout"
                : eligibility?.reason ?? undefined
            }
          />
          <StatCard
            title="Pending (In Hold)"
            value={formatSummaryAmount(summary?.pendingEarnings ?? 0)}
            icon={Clock}
            variant="warning"
            subtitle="Released after hold period"
          />
          <StatCard
            title="Already Paid Out"
            value={formatSummaryAmount(summary?.paidEarnings ?? 0)}
            icon={Wallet}
            variant="info"
          />
        </DashboardGrid>

        {/* Held earnings alert */}
        {summary && summary.heldEarnings > 0 && (
          <div className="mt-4 flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-800">
                {formatSummaryAmount(summary.heldEarnings)} is on hold
              </p>
              <p className="text-xs text-red-600">
                Earnings may be held due to disputes or policy review. Contact
                support if you have questions.
              </p>
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="mt-6 flex items-center gap-2 border-b border-zinc-200 pb-0 overflow-x-auto">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => {
                setStatusFilter(tab.value);
                setPage(0);
              }}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                statusFilter === tab.value
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Earnings Table */}
        <div className="mt-4 bg-white rounded-xl border border-zinc-200 overflow-hidden">
          {earnings.length === 0 ? (
            <div className="p-12 text-center text-zinc-500">
              <Wallet className="w-10 h-10 mx-auto mb-3 text-zinc-300" />
              <p className="font-medium">No earnings found</p>
              <p className="text-sm mt-1">
                {statusFilter !== "ALL"
                  ? `No ${statusFilter.toLowerCase()} earnings to display.`
                  : "Earnings will appear here after your appointments are completed and paid."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200">
                    <th className="text-left px-4 py-3 font-medium text-zinc-600">
                      Date
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-zinc-600">
                      Type
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-zinc-600">
                      Role
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600">
                      Payment
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600">
                      Your Earnings
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-zinc-600">
                      Platform Fee
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-zinc-600">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-zinc-600">
                      Payout
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {earnings.map((earning) => {
                    const config = statusConfig[earning.status];
                    const appointmentType =
                      earning.payment?.appointment?.appointmentType ?? "N/A";
                    return (
                      <tr
                        key={earning.id}
                        className="hover:bg-zinc-50 transition-colors"
                      >
                        <td className="px-4 py-3 text-zinc-600">
                          {formatDate(earning.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="capitalize text-zinc-800">
                            {appointmentType.toLowerCase()}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                            earning.role === "COLLABORATOR"
                              ? "bg-purple-50 text-purple-700"
                              : "bg-zinc-100 text-zinc-600"
                          }`}>
                            {earning.role === "COLLABORATOR"
                              ? `Collab ${earning.sharePercentage}%`
                              : earning.sharePercentage < 100
                                ? `Owner ${earning.sharePercentage}%`
                                : "Owner"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600">
                          {formatEarningAmount((earning.payment?.amount ?? 0) * 100, earning.payment?.currency ?? "INR")}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-zinc-900">
                          {formatEarningAmount(earning.consultantShare, earning.payment?.currency ?? "INR")}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-400">
                          {formatEarningAmount(earning.platformFee, earning.payment?.currency ?? "INR")}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={config.variant}
                            className={config.className}
                          >
                            {config.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {earning.payout ? (
                            <span className="flex items-center gap-1 text-xs text-zinc-500">
                              {earning.payout.status === "COMPLETED" ? (
                                <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                              ) : (
                                <Clock className="w-3.5 h-3.5 text-amber-500" />
                              )}
                              {earning.payout.processedAt
                                ? formatDate(earning.payout.processedAt)
                                : earning.payout.status}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {pagination && pagination.total > limit && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-200 bg-zinc-50">
              <p className="text-sm text-zinc-500">
                Showing {page * limit + 1}–
                {Math.min((page + 1) * limit, pagination.total)} of{" "}
                {pagination.total}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 bg-white hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!pagination.hasMore}
                  className="px-3 py-1.5 text-sm rounded-md border border-zinc-300 bg-white hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Payout eligibility info */}
        {eligibility && (
          <div className="mt-4 p-4 bg-zinc-50 rounded-lg border border-zinc-200">
            <div className="flex items-start gap-3">
              <ArrowUpRight className="w-5 h-5 text-zinc-400 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-zinc-700">
                  Payout Information
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  {eligibility.isEligible
                    ? `You have ${formatSummaryAmount(eligibility.readyAmount)} ready for payout. Payouts are processed weekly.`
                    : eligibility.reason ??
                      `Minimum payout threshold is ${formatSummaryAmount(eligibility.minimumAmount)}.`}
                </p>
              </div>
            </div>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
