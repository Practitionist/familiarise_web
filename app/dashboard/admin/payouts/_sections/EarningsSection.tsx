"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Wallet,
  TrendingUp,
  Clock,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import type { EarningsStats, Earning } from "@/types/payments";

interface EarningsStatsResponse {
  stats: EarningsStats;
}

interface EarningsListResponse {
  earnings: Earning[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchEarningsStats(): Promise<EarningsStatsResponse> {
  const response = await fetch("/api/admin/earnings/stats");
  if (!response.ok) {
    throw new Error("Failed to fetch earnings stats");
  }
  return response.json() as Promise<EarningsStatsResponse>;
}

async function fetchEarnings(
  status?: string,
  page = 1,
  limit = 20,
): Promise<EarningsListResponse> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: ((page - 1) * limit).toString(),
  });
  if (status) params.set("status", status);

  const response = await fetch(`/api/admin/earnings?${params}`);
  if (!response.ok) {
    throw new Error("Failed to fetch earnings");
  }
  return response.json() as Promise<EarningsListResponse>;
}

export default function EarningsSection() {
  const [status, setStatus] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["admin-earnings-stats"],
    queryFn: fetchEarningsStats,
    staleTime: 60 * 1000,
  });

  const { data: earningsData, isLoading: earningsLoading } = useQuery({
    queryKey: ["admin-earnings", status, page],
    queryFn: () => fetchEarnings(status, page, limit),
    staleTime: 30 * 1000,
  });

  const stats: EarningsStats = statsData?.stats || {
    pending: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    ready: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    paid: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    held: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    refunded: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    totalPlatformRevenue: 0,
  };

  const formatAmount = (amount: number) =>
    (amount / 100).toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
    });

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { bg: string; text: string }> = {
      PENDING: { bg: "bg-yellow-100", text: "text-yellow-800" },
      READY: { bg: "bg-blue-100", text: "text-blue-800" },
      PAID: { bg: "bg-green-100", text: "text-green-800" },
      HELD: { bg: "bg-orange-100", text: "text-orange-800" },
      REFUNDED: { bg: "bg-red-100", text: "text-red-800" },
    };
    const badge = badges[status] || {
      bg: "bg-gray-100",
      text: "text-gray-800",
    };
    return (
      <span
        className={`px-2 py-1 rounded text-xs font-medium ${badge.bg} ${badge.text}`}
      >
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {statsLoading ? (
          <>
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Pending (Hold)</p>
                    <p className="text-xl font-bold text-yellow-700">
                      {stats.pending.count}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatAmount(stats.pending.consultantSharePaise)}
                    </p>
                  </div>
                  <Clock className="w-8 h-8 text-yellow-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Ready for Payout</p>
                    <p className="text-xl font-bold text-blue-700">
                      {stats.ready.count}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatAmount(stats.ready.consultantSharePaise)}
                    </p>
                  </div>
                  <Wallet className="w-8 h-8 text-blue-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Paid Out</p>
                    <p className="text-xl font-bold text-green-700">
                      {stats.paid.count}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatAmount(stats.paid.consultantSharePaise)}
                    </p>
                  </div>
                  <CheckCircle className="w-8 h-8 text-green-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Held (Dispute)</p>
                    <p className="text-xl font-bold text-orange-700">
                      {stats.held.count}
                    </p>
                    <p className="text-xs text-gray-500">
                      {formatAmount(stats.held.consultantSharePaise)}
                    </p>
                  </div>
                  <AlertTriangle className="w-8 h-8 text-orange-500" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-r from-purple-50 to-indigo-50">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-purple-600">Platform Revenue</p>
                    <p className="text-xl font-bold text-purple-700">
                      {formatAmount(stats.totalPlatformRevenue)}
                    </p>
                    <p className="text-xs text-purple-500">Total fees earned</p>
                  </div>
                  <TrendingUp className="w-8 h-8 text-purple-500" />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Earnings List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">All Earnings</CardTitle>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value === "all" ? undefined : value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Filter status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="READY">Ready</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="HELD">Held</SelectItem>
                <SelectItem value="REFUNDED">Refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {earningsLoading || !earningsData ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : earningsData?.earnings?.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Consultant
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Gross
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Platform Fee
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Consultant Share
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {earningsData.earnings.map((earning: Earning) => (
                      <tr key={earning.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {earning.consultantProfile?.user?.name ||
                                "Unknown"}
                            </p>
                            <p className="text-xs text-gray-500">
                              {earning.consultantProfile?.user?.email}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {formatAmount(earning.grossAmount)}
                        </td>
                        <td className="px-4 py-3 text-sm text-purple-600">
                          {formatAmount(earning.platformFeePaise)}
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-green-700">
                          {formatAmount(earning.consultantSharePaise)}
                        </td>
                        <td className="px-4 py-3">
                          {getStatusBadge(earning.status)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {new Date(earning.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {earningsData?.pagination && (
                <div className="flex items-center justify-between pt-4">
                  <div className="text-sm text-gray-500">
                    Showing {(page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, earningsData.pagination.total)} of{" "}
                    {earningsData.pagination.total} earnings
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
                      disabled={!earningsData.pagination.hasMore}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">No earnings found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
