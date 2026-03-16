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
import { PaymentGateway, DisputeStatus } from "@prisma/client";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { Dispute, DisputeListResponse } from "@/types/disputes";

// Fetch disputes with filters
async function fetchDisputes(params: {
  page: number;
  limit: number;
  status?: DisputeStatus;
  gateway?: PaymentGateway;
  search?: string;
}): Promise<DisputeListResponse> {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/disputes?${searchParams}`);
  if (!response.ok) {
    throw new Error("Failed to fetch disputes");
  }
  return response.json() as Promise<DisputeListResponse>;
}

export default function AdminDisputesPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<DisputeStatus | undefined>();
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [search, setSearch] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-disputes", page, status, gateway, search],
    queryFn: () => fetchDisputes({ page, limit, status, gateway, search }),
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
                : "Failed to load disputes"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Disputes</h1>
        <p className="text-gray-600 mt-1">
          Manage and respond to payment disputes
        </p>
      </div>

      {/* Alert for Urgent Disputes */}
      {data && data.urgentDisputes > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <span className="text-2xl">⚠️</span>
              <div>
                <p className="font-semibold text-red-900">
                  {data.urgentDisputes} disputes require immediate attention
                </p>
                <p className="text-sm text-red-700">
                  These disputes have approaching deadlines and need responses.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Input
              placeholder="Search dispute ID..."
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
                  value === "all" ? undefined : (value as DisputeStatus),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="WARNING_NEEDS_RESPONSE">
                  Warning Needs Response
                </SelectItem>
                <SelectItem value="NEEDS_RESPONSE">Needs Response</SelectItem>
                <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                <SelectItem value="WON">Won</SelectItem>
                <SelectItem value="LOST">Lost</SelectItem>
                <SelectItem value="CHARGE_REFUNDED">Charge Refunded</SelectItem>
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

      {/* Disputes Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Disputes ({data?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.disputes?.length > 0 ? (
            <div className="space-y-2">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Dispute ID
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
                        Due By
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.disputes.map((dispute: Dispute) => {
                      const isUrgent =
                        dispute.dueBy &&
                        new Date(dispute.dueBy) <
                          new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

                      return (
                        <tr
                          key={dispute.id}
                          className={`hover:bg-gray-50 ${isUrgent ? "bg-red-50" : ""}`}
                        >
                          <td className="px-4 py-3 text-sm font-mono text-gray-900">
                            {dispute.disputeId?.substring(0, 20)}...
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {formatCurrencyAmount(
                              dispute.amount,
                              dispute.currency,
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span
                              className={`px-2 py-1 rounded text-xs font-medium ${
                                dispute.status === "WON"
                                  ? "bg-green-100 text-green-800"
                                  : dispute.status === "LOST"
                                    ? "bg-red-100 text-red-800"
                                    : dispute.status === "NEEDS_RESPONSE" ||
                                        dispute.status ===
                                          "WARNING_NEEDS_RESPONSE"
                                      ? "bg-yellow-100 text-yellow-800"
                                      : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {dispute.status.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {dispute.paymentGateway}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {dispute.reason}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {dispute.dueBy ? (
                              <span
                                className={
                                  isUrgent
                                    ? "text-red-600 font-medium"
                                    : "text-gray-500"
                                }
                              >
                                {new Date(dispute.dueBy).toLocaleDateString()}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <Link
                              href={`/dashboard/admin/disputes/${dispute.id}`}
                              className="text-blue-600 hover:text-blue-700 font-medium"
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4">
                <div className="text-sm text-gray-500">
                  Showing {(page - 1) * limit + 1} to{" "}
                  {Math.min(page * limit, data.total)} of {data.total} disputes
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
              <p className="text-gray-500">No disputes found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
