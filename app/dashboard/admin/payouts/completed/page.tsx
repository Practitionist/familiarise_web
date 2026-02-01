"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { CheckCircle, Download } from "lucide-react";

import type { Payout } from "@/types/payouts";

async function fetchCompletedPayouts(
  page: number,
  limit: number,
  search: string,
) {
  const offset = (page - 1) * limit;
  const params = new URLSearchParams({
    status: "COMPLETED",
    limit: limit.toString(),
    offset: offset.toString(),
  });
  if (search) {
    params.set("search", search);
  }
  const response = await fetch(`/api/admin/payouts?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json();
}

export default function CompletedPayoutsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const limit = 20;

  // Debounced search for API calls
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset to page 1 when search changes
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-completed", page, debouncedSearch],
    queryFn: () => fetchCompletedPayouts(page, limit, debouncedSearch),
    staleTime: 60 * 1000,
  });

  // Payouts are now filtered server-side
  const filteredPayouts = data?.payouts;

  const exportToCSV = () => {
    if (!data?.payouts?.length) return;

    const headers = [
      "ID",
      "Consultant",
      "Email",
      "Amount",
      "Currency",
      "Method",
      "Provider",
      "Processed At",
    ];
    const rows = data.payouts.map((p: Payout) => [
      p.id,
      p.consultantName,
      p.consultantEmail,
      (p.amount / 100).toFixed(2),
      p.currency,
      p.method,
      p.provider,
      p.processedAt ? new Date(p.processedAt).toISOString() : "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r: string[]) => r.join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payouts-completed-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
                : "Failed to load payouts"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            Completed Payouts
          </h1>
          <p className="text-gray-600 mt-1">
            Successfully completed payout history
          </p>
        </div>
        <Button variant="outline" onClick={exportToCSV}>
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4">
          <Input
            placeholder="Search by consultant name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600" />
            Completed ({data?.pagination?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filteredPayouts?.length > 0 ? (
            <>
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
                        Earnings
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Processed
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredPayouts.map((payout: Payout) => (
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
                        <td className="px-4 py-3 text-sm font-semibold text-green-700">
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
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {payout.earningsCount} earnings
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {payout.processedAt
                            ? new Date(payout.processedAt).toLocaleString()
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {data?.pagination && (
                <div className="flex items-center justify-between pt-4">
                  <div className="text-sm text-gray-500">
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
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">
                {search
                  ? "No payouts match your search"
                  : "No completed payouts"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
