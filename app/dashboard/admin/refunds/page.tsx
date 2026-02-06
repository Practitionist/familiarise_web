"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { PaymentGateway, RefundStatus } from "@prisma/client";
import { formatAmountFromPaise } from "@/lib/utils";

// Fetch refunds with filters
async function fetchRefunds(params: {
  page: number;
  limit: number;
  status?: RefundStatus;
  gateway?: PaymentGateway;
  search?: string;
}) {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/refunds?${searchParams}`);
  if (!response.ok) {
    throw new Error("Failed to fetch refunds");
  }
  return response.json();
}

export default function AdminRefundsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<RefundStatus | undefined>();
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [search, setSearch] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-refunds", page, status, gateway, search],
    queryFn: () => fetchRefunds({ page, limit, status, gateway, search }),
    staleTime: 30 * 1000,
  });

  const handleFilterChange = () => {
    setPage(1);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error
                ? error.message
                : "Failed to load refunds"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Refunds</h1>
        <p className="text-gray-600 mt-1">
          Manage and view all payment refunds
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Input
              placeholder="Search refund ID..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                handleFilterChange();
              }}
            />

            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(
                  value === "all" ? undefined : (value as RefundStatus),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={gateway}
              onValueChange={(value) => {
                setGateway(
                  value === "all" ? undefined : (value as PaymentGateway),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Gateway" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Gateways</SelectItem>
                <SelectItem value="STRIPE">Stripe</SelectItem>
                <SelectItem value="RAZORPAY">Razorpay</SelectItem>
                <SelectItem value="LEMON_SQUEEZY">Lemon Squeezy</SelectItem>
                <SelectItem value="XFLOW">Xflow</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              onClick={() => {
                setStatus(undefined);
                setGateway(undefined);
                setSearch("");
                setPage(1);
              }}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Refunds Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Refunds ({data?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.refunds?.length > 0 ? (
            <div className="space-y-2">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Refund ID
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Amount
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Gateway
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Reason
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.refunds.map((refund: any) => (
                      <tr key={refund.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-mono text-gray-900">
                          {refund.refundId?.substring(0, 20)}...
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {formatAmountFromPaise(refund.amount, refund.currency)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              refund.status === "SUCCEEDED"
                                ? "bg-green-100 text-green-800"
                                : refund.status === "PENDING"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : refund.status === "CANCELLED"
                                    ? "bg-gray-100 text-gray-800"
                                    : "bg-red-100 text-red-800"
                            }`}
                          >
                            {refund.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {refund.paymentGateway}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {refund.reason || "—"}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {new Date(refund.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <Link
                            href={`/dashboard/admin/payments/${refund.paymentId}`}
                            className="text-blue-600 hover:text-blue-700 font-medium"
                          >
                            View Payment
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4">
                <div className="text-sm text-gray-500">
                  Showing {(page - 1) * limit + 1} to{" "}
                  {Math.min(page * limit, data.total)} of {data.total} refunds
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
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">No refunds found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
