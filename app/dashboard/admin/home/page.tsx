"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

// Fetch admin dashboard stats
async function fetchAdminStats() {
  const response = await fetch("/api/admin/stats");
  if (!response.ok) {
    throw new Error("Failed to fetch admin stats");
  }
  return response.json();
}

export default function AdminHomePage() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: fetchAdminStats,
    staleTime: 1 * 60 * 1000, // 1 minute
    refetchInterval: 2 * 60 * 1000, // Refetch every 2 minutes
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-[100px]" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[60px]" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-1">
          Overview of platform payments and transactions
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Total Payments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-900">
              {stats?.totalPayments || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {stats?.totalPaymentsValue || "₹0"} total value
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Pending Payments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {stats?.pendingPayments || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {stats?.pendingPaymentsValue || "₹0"} pending
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Refunds
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {stats?.totalRefunds || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {stats?.totalRefundsValue || "₹0"} refunded
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-600">
              Disputes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {stats?.activeDisputes || 0}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {stats?.totalDisputes || 0} total
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Payments</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.recentPayments?.length > 0 ? (
              <div className="space-y-3">
                {stats.recentPayments.map((payment: any) => (
                  <Link
                    key={payment.id}
                    href={`/dashboard/admin/payments/${payment.id}`}
                    className="block p-3 border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium text-gray-900">
                          {payment.amount} {payment.currency}
                        </p>
                        <p className="text-sm text-gray-500">
                          {payment.paymentGateway} • {payment.appointmentType}
                        </p>
                      </div>
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          payment.paymentStatus === "SUCCEEDED"
                            ? "bg-green-100 text-green-800"
                            : payment.paymentStatus === "PENDING"
                              ? "bg-yellow-100 text-yellow-800"
                              : "bg-red-100 text-red-800"
                        }`}
                      >
                        {payment.paymentStatus}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No recent payments</p>
            )}
            <Link
              href="/dashboard/admin/payments"
              className="block mt-4 text-blue-600 hover:text-blue-700 text-sm font-medium"
            >
              View all payments →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Refunds</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.recentRefunds?.length > 0 ? (
              <div className="space-y-3">
                {stats.recentRefunds.map((refund: any) => (
                  <Link
                    key={refund.id}
                    href={`/dashboard/admin/refunds/${refund.id}`}
                    className="block p-3 border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-medium text-gray-900">
                          {refund.amount} {refund.currency}
                        </p>
                        <p className="text-sm text-gray-500">
                          {refund.paymentGateway}
                        </p>
                      </div>
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          refund.status === "SUCCEEDED"
                            ? "bg-green-100 text-green-800"
                            : refund.status === "PENDING"
                              ? "bg-yellow-100 text-yellow-800"
                              : "bg-red-100 text-red-800"
                        }`}
                      >
                        {refund.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No recent refunds</p>
            )}
            <Link
              href="/dashboard/admin/refunds"
              className="block mt-4 text-blue-600 hover:text-blue-700 text-sm font-medium"
            >
              View all refunds →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Gateway Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Payment Gateway Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"].map((gateway) => (
              <div
                key={gateway}
                className="p-4 border rounded-lg flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-gray-900">{gateway}</p>
                  <p className="text-sm text-gray-500">
                    {stats?.gatewayStats?.[gateway]?.count || 0} payments
                  </p>
                </div>
                <div
                  className={`h-3 w-3 rounded-full ${
                    gateway === "STRIPE" || gateway === "RAZORPAY"
                      ? "bg-green-500"
                      : "bg-gray-300"
                  }`}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
