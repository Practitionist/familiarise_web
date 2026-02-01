"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Loader } from "lucide-react";

import type { Payout } from "@/types/payouts";

async function fetchProcessingPayouts() {
  const response = await fetch(
    "/api/admin/payouts?status=PROCESSING&limit=100",
  );
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json();
}

export default function ProcessingPayoutsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-processing"],
    queryFn: fetchProcessingPayouts,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Refresh every minute
  });

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
                : "Failed to load payouts"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Processing Payouts</h1>
        <p className="text-gray-600 mt-1">
          Payouts being processed by payment providers
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Loader className="w-5 h-5 animate-spin text-blue-600" />
            Processing ({data?.payouts?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.payouts?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Consultant
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Provider
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Method
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Approved
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.payouts.map((payout: Payout) => (
                    <tr key={payout.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {payout.consultantName}
                          </p>
                          <p className="text-xs text-gray-500">
                            {payout.consultantEmail}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                        {(payout.amount / 100).toLocaleString("en-IN", {
                          style: "currency",
                          currency: payout.currency,
                        })}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {payout.provider}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        {payout.method}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {payout.approvedAt
                          ? new Date(payout.approvedAt).toLocaleString()
                          : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          <Loader className="w-3 h-3 mr-1 animate-spin" />
                          Processing
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">No payouts currently processing</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="p-4">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> Processing payouts are updated via webhooks
            from payment providers. The status will automatically change to
            Completed or Failed once the provider confirms the transfer.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
