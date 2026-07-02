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
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Wallet,
  ClipboardCheck,
  Loader,
  CheckCircle,
  XCircle,
} from "lucide-react";

import type { Payout } from "@/types/payouts";

interface PayoutStatCategory {
  count: number;
  amount: number;
}

interface PayoutListResponse {
  payouts: Payout[];
  stats: {
    pending: PayoutStatCategory;
    approved: PayoutStatCategory;
    processing: PayoutStatCategory;
    completed: PayoutStatCategory;
    failed: PayoutStatCategory;
  };
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchPayouts(
  status?: string,
  page = 1,
  limit = 20,
): Promise<PayoutListResponse> {
  const offset = (page - 1) * limit;
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  });
  if (status) params.set("status", status);

  const response = await fetch(`/api/staff/payouts?${params}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json() as Promise<PayoutListResponse>;
}

export default function StaffPayoutsPage() {
  const [status, setStatus] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["staff-payouts", status, page],
    queryFn: () => fetchPayouts(status, page, limit),
    staleTime: 30 * 1000,
  });

  const stats = data?.stats || {
    pending: { count: 0, amount: 0 },
    approved: { count: 0, amount: 0 },
    processing: { count: 0, amount: 0 },
    completed: { count: 0, amount: 0 },
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<
      string,
      { bg: string; text: string; icon: React.ReactNode }
    > = {
      PENDING: {
        bg: "bg-yellow-100 dark:bg-yellow-900",
        text: "text-yellow-800 dark:text-yellow-300",
        icon: <ClipboardCheck className="w-3 h-3" />,
      },
      APPROVED: {
        bg: "bg-muted",
        text: "text-foreground",
        icon: <CheckCircle className="w-3 h-3" />,
      },
      PROCESSING: {
        bg: "bg-muted",
        text: "text-foreground",
        icon: <Loader className="w-3 h-3 animate-spin" />,
      },
      COMPLETED: {
        bg: "bg-green-100 dark:bg-green-900",
        text: "text-green-800 dark:text-green-300",
        icon: <CheckCircle className="w-3 h-3" />,
      },
      FAILED: {
        bg: "bg-red-100 dark:bg-red-900",
        text: "text-red-800 dark:text-red-300",
        icon: <XCircle className="w-3 h-3" />,
      },
    };
    const badge = badges[status] || {
      bg: "bg-muted",
      text: "text-muted-foreground",
      icon: null,
    };
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${badge.bg} ${badge.text}`}
      >
        {badge.icon}
        {status}
      </span>
    );
  };

  const payoutColumns: ResponsiveColumn<Payout>[] = [
    {
      key: "consultant",
      header: "Consultant",
      primary: true,
      cell: (payout) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {payout.consultantName}
          </p>
          <p className="text-xs text-muted-foreground">
            {payout.consultantEmail}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "text-sm font-semibold text-foreground",
      cell: (payout) =>
        (payout.amount / 100).toLocaleString("en-IN", {
          style: "currency",
          currency: payout.currency,
        }),
    },
    {
      key: "method",
      header: "Method",
      className: "text-sm text-muted-foreground",
      cell: (payout) => payout.method,
    },
    {
      key: "status",
      header: "Status",
      cell: (payout) => getStatusBadge(payout.status),
    },
    {
      key: "date",
      header: "Date",
      className: "text-sm text-muted-foreground",
      cell: (payout) => new Date(payout.createdAt).toLocaleDateString(),
    },
  ];

  const payoutsEmpty = (
    <div className="text-center py-12">
      <p className="text-muted-foreground">No payouts found</p>
    </div>
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
                : "Failed to load payouts"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payouts"
        subtitle="View consultant payout status and history"
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          <>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Pending</p>
                    <p className="text-2xl font-bold text-foreground">
                      {stats.pending?.count || 0}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted">
                    <ClipboardCheck className="w-5 h-5 text-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Processing</p>
                    <p className="text-2xl font-bold text-foreground">
                      {stats.processing?.count || 0}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted">
                    <Loader className="w-5 h-5 text-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Completed</p>
                    <p className="text-2xl font-bold text-foreground">
                      {stats.completed?.count || 0}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted">
                    <CheckCircle className="w-5 h-5 text-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Total Payouts
                    </p>
                    <p className="text-2xl font-bold text-foreground">
                      {data?.pagination?.total || 0}
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-muted">
                    <Wallet className="w-5 h-5 text-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Filter */}
      <Card>
        <CardContent className="pt-4">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value === "all" ? undefined : value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="PROCESSING">Processing</SelectItem>
              <SelectItem value="COMPLETED">Completed</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Payouts Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Wallet className="w-5 h-5 text-muted-foreground" />
            Payouts ({data?.pagination?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <>
              <ResponsiveTable<Payout>
                columns={payoutColumns}
                rows={data.payouts}
                getRowId={(p) => p.id}
                empty={payoutsEmpty}
              />

              {/* Pagination */}
              {data.payouts.length > 0 && data?.pagination && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-4">
                  <div className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, data.pagination.total)} of{" "}
                    {data.pagination.total} payouts
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
                      disabled={!data.pagination.hasMore}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
