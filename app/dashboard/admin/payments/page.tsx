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
import { PaymentGateway, PaymentStatus, AppointmentsType } from "@prisma/client";

// Fetch payments with filters
async function fetchPayments(params: {
  page: number;
  limit: number;
  status?: PaymentStatus;
  gateway?: PaymentGateway;
  appointmentType?: AppointmentsType;
  search?: string;
}) {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.appointmentType && { appointmentType: params.appointmentType }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/payments?${searchParams}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payments");
  }
  return response.json();
}

export default function AdminPaymentsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | undefined>();
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [appointmentType, setAppointmentType] = useState<
    AppointmentsType | undefined
  >();
  const [search, setSearch] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payments", page, status, gateway, appointmentType, search],
    queryFn: () =>
      fetchPayments({ page, limit, status, gateway, appointmentType, search }),
    staleTime: 30 * 1000, // 30 seconds
  });

  const handleFilterChange = () => {
    setPage(1); // Reset to first page when filters change
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
                : "Failed to load payments"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Payments</h1>
        <p className="text-gray-600 mt-1">
          Manage and view all platform payments
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <Input
              placeholder="Search payment ID..."
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
                  value === "all" ? undefined : (value as PaymentStatus),
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

            <Select
              value={appointmentType}
              onValueChange={(value) => {
                setAppointmentType(
                  value === "all" ? undefined : (value as AppointmentsType),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="CONSULTATION">Consultation</SelectItem>
                <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                <SelectItem value="WEBINAR">Webinar</SelectItem>
                <SelectItem value="CLASS">Class</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              onClick={() => {
                setStatus(undefined);
                setGateway(undefined);
                setAppointmentType(undefined);
                setSearch("");
                setPage(1);
              }}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Payments Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Payments ({data?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.payments?.length > 0 ? (
            <div className="space-y-2">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Payment ID
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
                        Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Mock
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
                    {data.payments.map((payment: any) => (
                      <tr key={payment.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-mono text-gray-900">
                          {payment.paymentIntent?.substring(0, 20)}...
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {payment.amount} {payment.currency}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium ${
                              payment.paymentStatus === "SUCCEEDED"
                                ? "bg-green-100 text-green-800"
                                : payment.paymentStatus === "PENDING"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : "bg-red-100 text-red-800"
                            }`}
                          >
                            {payment.paymentStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {payment.paymentGateway}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {payment.appointment?.appointmentType || "N/A"}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {payment.isMockPayment ? (
                            <span className="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-800">
                              MOCK
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {new Date(payment.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <Link
                            href={`/dashboard/admin/payments/${payment.id}`}
                            className="text-blue-600 hover:text-blue-700 font-medium"
                          >
                            View
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
                  {Math.min(page * limit, data.total)} of {data.total} payments
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
              <p className="text-gray-500">No payments found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
